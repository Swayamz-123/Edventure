const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PointLedger = require('./models/PointLedger');
const GameMatch = require('./models/GameMatch');

const QUESTION_TIME_LIMIT_MS = 30_000;
const ANSWER_GRACE_MS = 5_000;

module.exports = function registerGameHandlers(io, generateQuestions, User) {
  const gameRooms = new Map();
  const waitingPlayers = new Map();

  async function loadQuestions(subject, difficulty, classLevel) {
    try {
      const questions = await generateQuestions(subject, difficulty, classLevel);
      if (Array.isArray(questions) && questions.length) return questions.slice(0, 10);
    } catch (error) {
      console.warn('Question generation failed:', error?.name || 'UnknownError');
    }

    try {
      const filePath = path.join(__dirname, 'battlegrounds-questions.json');
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const allQuestions = data.questions || data;
      return allQuestions.filter(question =>
        String(question.subject || '').toLowerCase() === subject.toLowerCase() &&
        String(question.difficulty || '').toLowerCase() === difficulty.toLowerCase() &&
        Number(question.class) === Number(classLevel)
      ).sort(() => Math.random() - 0.5).slice(0, 5);
    } catch (error) {
      console.error('Unable to load fallback questions:', error?.name || 'UnknownError');
      return [];
    }
  }

  function publicQuestion(question, index) {
    // Deliberately allow-list fields instead of returning answer keys or provider metadata.
    return {
      id: String(question.id || `question-${index + 1}`),
      subject: String(question.subject || ''),
      class: Number(question.class) || undefined,
      difficulty: String(question.difficulty || ''),
      question: String(question.question || ''),
      options: Array.isArray(question.options) ? question.options.slice(0, 4).map(String) : [],
      points: Number.isFinite(Number(question.points)) ? Math.max(0, Math.min(100, Number(question.points))) : 10,
      timeLimit: 30
    };
  }

  function normalizeCorrectAnswer(question) {
    if (Number.isInteger(question.correctAnswer) &&
        question.correctAnswer >= 0 && question.correctAnswer < 4) {
      return question.correctAnswer;
    }
    if (typeof question.correctAnswer === 'string' && Array.isArray(question.options)) {
      return question.options.indexOf(question.correctAnswer);
    }
    return -1;
  }

  function findPlayer(game, socketId) {
    return game.players.find(player => player.socketId === socketId);
  }

  function playerResult(game, player) {
    return {
      username: player.userData.username,
      userId: player.userData.userId,
      score: game.scores[player.socketId],
      points: game.scores[player.socketId],
      answers: game.answers[player.socketId] || []
    };
  }

  async function awardPointsOnce(userId, eventId, points) {
    const filter = { userId, eventId };
    const record = {
      userId,
      eventId,
      points: Math.max(0, Math.floor(points)),
      reason: 'multiplayer-game-completion'
    };

    try {
      const result = await PointLedger.updateOne(
        filter,
        { $setOnInsert: record },
        { upsert: true }
      );
      if (result.upsertedCount !== 1) return false;

      const userUpdate = await User.updateOne(
        { _id: userId },
        { $inc: { points: record.points } }
      );
      if (userUpdate.matchedCount !== 1) {
        await PointLedger.deleteOne(filter);
        return false;
      }
      return true;
    } catch (error) {
      // A concurrent duplicate event is safe: the unique ledger index blocks a
      // second credit. Other failures are logged without leaking request data.
      if (error?.code !== 11000) {
        console.error('Point ledger write failed:', error?.name || 'UnknownError');
      }
      return false;
    }
  }

  io.on('connection', socket => {
    socket.on('join-lobby', async data => {
      // Session identity is supplied by the server-side Passport middleware.
      const authenticatedUser = socket.request?.user;
      if (!authenticatedUser?._id) {
        socket.emit('auth-error', { message: 'Authentication required for battlegrounds' });
        return;
      }

      const subject = typeof data?.subject === 'string' ? data.subject.trim() : '';
      const difficulty = typeof data?.difficulty === 'string' ? data.difficulty.trim() : '';
      const classLevel = Number.parseInt(data?.classLevel, 10);
      const mode = typeof data?.mode === 'string' ? data.mode.trim() : 'multiplayer';
      if (!subject || subject.length > 60 || !difficulty || difficulty.length > 30 ||
          !Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12 ||
          !mode || mode.length > 30) {
        socket.emit('lobby-error', { message: 'Invalid lobby settings.' });
        return;
      }

      const userId = String(authenticatedUser._id);
      const username = String(authenticatedUser.username || authenticatedUser.name || authenticatedUser.email?.split('@')[0] || 'Learner');
      const userData = { userId, username, subject, difficulty, classLevel, mode };
      socket.userData = userData;

      const roomKey = `${subject.toLowerCase()}-${difficulty.toLowerCase()}-${classLevel}-${mode.toLowerCase()}`;
      if (!waitingPlayers.has(roomKey)) waitingPlayers.set(roomKey, []);
      const waiting = waitingPlayers.get(roomKey);

      // Remove any stale duplicate socket for the same account from this queue.
      const duplicate = waiting.find(player => player.userData.userId === userId);
      if (duplicate) {
        socket.emit('already-in-room', { roomKey });
        return;
      }

      waiting.push({ socketId: socket.id, userData });
      socket.join(roomKey);

      if (waiting.length < 2) {
        socket.emit('waiting-for-opponent', { position: waiting.length });
        return;
      }

      const players = waiting.splice(0, 2);
      const gameId = crypto.randomUUID();
      const gameQuestions = await loadQuestions(subject, difficulty, classLevel);
      if (!gameQuestions.length ||
          gameQuestions.some(question => !Array.isArray(question.options) || question.options.length !== 4 ||
            normalizeCorrectAnswer(question) < 0)) {
        for (const player of players) {
          io.to(player.socketId).emit('lobby-error', { message: 'Questions could not be prepared. Please retry.' });
          const waitingSocket = io.sockets.sockets.get(player.socketId);
          if (waitingSocket) waitingSocket.leave(roomKey);
        }
        return;
      }

      const startedAt = Date.now();
      const game = {
        id: gameId,
        players,
        subject,
        difficulty,
        classLevel,
        mode,
        questions: gameQuestions,
        status: 'active',
        startedAt,
        scores: Object.fromEntries(players.map(player => [player.socketId, 0])),
        answers: Object.fromEntries(players.map(player => [player.socketId, []])),
        questionStartedAt: Object.fromEntries(players.map(player => [player.socketId, { 0: startedAt }])),
        completed: Object.fromEntries(players.map(player => [player.socketId, false])),
        completionAwarded: false
      };
      gameRooms.set(gameId, game);

      try {
        await GameMatch.create({
          gameId,
          subject,
          difficulty,
          classLevel,
          mode,
          status: 'active',
          questionCount: gameQuestions.length,
          players: players.map(player => ({
            userId: player.userData.userId,
            username: player.userData.username,
            score: 0,
            answers: [],
            completed: false
          })),
          questions: gameQuestions,
          startedAt: new Date(startedAt),
          createdAt: new Date(startedAt),
          updatedAt: new Date(startedAt)
        });
      } catch (error) {
        gameRooms.delete(gameId);
        console.error('Match persistence failed:', error?.name || 'UnknownError');
        for (const player of players) {
          io.to(player.socketId).emit('lobby-error', { message: 'The match could not be started safely. Please retry.' });
          const waitingSocket = io.sockets.sockets.get(player.socketId);
          if (waitingSocket) waitingSocket.leave(roomKey);
        }
        return;
      }

      for (const player of players) {
        const opponent = players.find(candidate => candidate.socketId !== player.socketId);
        io.to(player.socketId).emit('game-start', {
          gameId,
          opponent: opponent.userData,
          subject,
          difficulty,
          classLevel,
          mode,
          questions: gameQuestions.map(publicQuestion)
        });
      }
    });

    socket.on('submit-answer', async data => {
      const gameId = typeof data?.gameId === 'string' ? data.gameId : '';
      const game = gameRooms.get(gameId);
      const player = game && findPlayer(game, socket.id);
      if (!socket.request?.user?._id || !game || !player || game.status !== 'active' ||
          String(socket.request.user._id) !== player.userData.userId) {
        socket.emit('answer-rejected', { message: 'This game is unavailable for your session.' });
        return;
      }

      const questionIndex = data?.questionIndex;
      const answerIndex = data?.answerIndex;
      const playerAnswers = game.answers[socket.id];
      if (!Number.isInteger(questionIndex) || questionIndex !== playerAnswers.length ||
          questionIndex < 0 || questionIndex >= game.questions.length ||
          !Number.isInteger(answerIndex) || answerIndex < -1 || answerIndex > 3) {
        socket.emit('answer-rejected', { message: 'Invalid or duplicate answer submission.' });
        return;
      }

      const now = Date.now();
      const questionStartedAt = game.questionStartedAt[socket.id][questionIndex];
      if (!questionStartedAt) {
        socket.emit('answer-rejected', { message: 'This question has not been opened yet.' });
        return;
      }
      const elapsedMs = now - questionStartedAt;
      if (elapsedMs < -250 || elapsedMs > QUESTION_TIME_LIMIT_MS + ANSWER_GRACE_MS) {
        socket.emit('answer-rejected', { message: 'The answer arrived outside the allowed time window.' });
        return;
      }

      const serverTimeLeft = Math.max(0, Math.ceil((QUESTION_TIME_LIMIT_MS - elapsedMs) / 1000));
      const question = game.questions[questionIndex];
      const correctAnswer = normalizeCorrectAnswer(question);
      const isCorrect = answerIndex !== -1 && answerIndex === correctAnswer;
      const basePoints = Number.isFinite(Number(question.points)) ? Math.max(0, Math.min(100, Number(question.points))) : 10;
      const earnedPoints = isCorrect ? basePoints + Math.floor(serverTimeLeft / 3) : 0;

      const answerRecord = {
        questionIndex,
        answerIndex,
        timeLeft: serverTimeLeft,
        timeTaken: Math.max(0, Math.ceil(elapsedMs / 1000)),
        isCorrect,
        points: earnedPoints
      };
      // Reserve the answer synchronously so two rapid socket events cannot both
      // submit the same index while the MongoDB persistence is in flight.
      playerAnswers.push(answerRecord);
      game.scores[socket.id] += earnedPoints;

      const playerIndex = game.players.findIndex(candidate => candidate.socketId === socket.id);
      try {
        const persisted = await GameMatch.updateOne(
          {
            gameId: game.id,
            status: 'active',
            [`players.${playerIndex}.answers`]: { $size: questionIndex }
          },
          {
            $push: { [`players.${playerIndex}.answers`]: answerRecord },
            $set: {
              [`players.${playerIndex}.score`]: game.scores[socket.id],
              updatedAt: new Date()
            }
          }
        );
        if (persisted.matchedCount !== 1) {
          throw new Error('Match state changed before answer persistence.');
        }
      } catch (error) {
        playerAnswers.pop();
        game.scores[socket.id] = Math.max(0, game.scores[socket.id] - earnedPoints);
        console.error('Match answer persistence failed:', error?.name || 'UnknownError');
        socket.emit('answer-rejected', { message: 'Your answer could not be saved. Please retry.' });
        return;
      }

      if (questionIndex + 1 < game.questions.length) {
        game.questionStartedAt[socket.id][questionIndex + 1] = now;
      }

      const first = playerResult(game, game.players[0]);
      const second = playerResult(game, game.players[1]);
      const otherPlayer = game.players.find(candidate => candidate.socketId !== socket.id);
      const otherHasAnswered = game.answers[otherPlayer.socketId].length > questionIndex;
      const results = {
        questionIndex,
        // Don't reveal the answer until both players have locked in this question.
        correctAnswer: otherHasAnswered ? correctAnswer : null,
        player1: first,
        player2: second
      };
      game.players.forEach(candidate => io.to(candidate.socketId).emit('round-results', results));
    });

    socket.on('game-complete', async data => {
      const game = typeof data?.gameId === 'string' ? gameRooms.get(data.gameId) : null;
      const player = game && findPlayer(game, socket.id);
      if (!socket.request?.user?._id || !game || !player ||
          String(socket.request.user._id) !== player.userData.userId ||
          game.status !== 'active') {
        socket.emit('answer-rejected', { message: 'This game cannot be completed by this session.' });
        return;
      }
      if (game.answers[socket.id].length !== game.questions.length) {
        socket.emit('answer-rejected', { message: 'Answer all questions before completing the game.' });
        return;
      }
      if (game.completed[socket.id]) return;

      const playerIndex = game.players.findIndex(candidate => candidate.socketId === socket.id);
      try {
        const persisted = await GameMatch.updateOne(
          {
            gameId: game.id,
            status: 'active',
            [`players.${playerIndex}.answers`]: { $size: game.questions.length }
          },
          { $set: { [`players.${playerIndex}.completed`]: true, updatedAt: new Date() } }
        );
        if (persisted.matchedCount !== 1) throw new Error('Match completion state did not match the durable record.');
      } catch (error) {
        console.error('Match completion persistence failed:', error?.name || 'UnknownError');
        socket.emit('answer-rejected', { message: 'Your match completion could not be saved. Please retry.' });
        return;
      }
      game.completed[socket.id] = true;

      if (!Object.values(game.completed).every(Boolean)) return;
      if (game.completionAwarded) return;

      const firstScore = game.scores[game.players[0].socketId];
      const secondScore = game.scores[game.players[1].socketId];
      const winnerPlayer = firstScore === secondScore
        ? null
        : firstScore > secondScore ? game.players[0] : game.players[1];

      const finalScores = {
        gameId: game.id,
        subject: game.subject,
        difficulty: game.difficulty,
        classLevel: game.classLevel,
        questions: game.questions.map((question, index) => ({
          ...publicQuestion(question, index),
          correctAnswer: normalizeCorrectAnswer(question)
        })),
        player1: playerResult(game, game.players[0]),
        player2: playerResult(game, game.players[1]),
        winner: winnerPlayer ? winnerPlayer.userData.username : 'tie'
      };
      finalScores.answers = {
        [finalScores.player1.username]: finalScores.player1.answers,
        [finalScores.player2.username]: finalScores.player2.answers,
        [finalScores.player1.userId]: finalScores.player1.answers,
        [finalScores.player2.userId]: finalScores.player2.answers
      };

      try {
        const persisted = await GameMatch.updateOne(
          { gameId: game.id, status: 'active' },
          {
            $set: {
              status: 'completed',
              winnerUserId: winnerPlayer ? winnerPlayer.userData.userId : null,
              completedAt: new Date(),
              updatedAt: new Date(),
              'players.0.score': firstScore,
              'players.0.answers': game.answers[game.players[0].socketId],
              'players.0.completed': true,
              'players.1.score': secondScore,
              'players.1.answers': game.answers[game.players[1].socketId],
              'players.1.completed': true
            }
          }
        );
        if (persisted.matchedCount !== 1) throw new Error('Match was not active during completion.');
      } catch (error) {
        game.completed[game.players[0].socketId] = false;
        game.completed[game.players[1].socketId] = false;
        console.error('Completed match could not be persisted:', error?.name || 'UnknownError');
        game.players.forEach(candidate => io.to(candidate.socketId).emit('answer-rejected', {
          message: 'The final result could not be saved. Please retry completion.'
        }));
        return;
      }

      game.completionAwarded = true;
      game.status = 'completed';
      game.players.forEach(candidate => io.to(candidate.socketId).emit('game-final-results', finalScores));

      await Promise.all(game.players.map(candidate =>
        awardPointsOnce(candidate.userData.userId, `${game.id}:completion`, game.scores[candidate.socketId])
      ));
      setTimeout(() => gameRooms.delete(gameIdFromPlayers(game, game.id)), 5_000);
    });

    socket.on('disconnect', () => {
      for (const [roomKey, waiting] of waitingPlayers.entries()) {
        const index = waiting.findIndex(player => player.socketId === socket.id);
        if (index !== -1) waiting.splice(index, 1);
        if (waiting.length === 0) waitingPlayers.delete(roomKey);
      }

      for (const [gameId, game] of gameRooms.entries()) {
        const playerIndex = game.players.findIndex(player => player.socketId === socket.id);
        if (playerIndex < 0 || game.status === 'completed') continue;
        game.status = 'abandoned';
        GameMatch.updateOne(
          { gameId, status: 'active' },
          { $set: { status: 'abandoned', updatedAt: new Date() } }
        ).catch(error => console.error('Could not persist abandoned match:', error?.name || 'UnknownError'));
        const opponent = game.players[1 - playerIndex];
        if (opponent) io.to(opponent.socketId).emit('opponent-disconnected');
        setTimeout(() => gameRooms.delete(gameId), 10_000);
      }
    });
  });
};

function gameIdFromPlayers(game, fallback) {
  return typeof game?.id === 'string' ? game.id : fallback;
}
