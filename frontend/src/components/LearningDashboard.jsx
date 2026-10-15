import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import Sidebar from './SideBar';

const API = import.meta.env.VITE_BACKEND_URL;
const pct = value => `${Math.round((Number(value) || 0) * 100)}%`;
const dateLabel = value => {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not scheduled' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function LearningDashboard() {
  const [overview, setOverview] = useState(null);
  const [mistakes, setMistakes] = useState([]);
  const [mistakeFilter, setMistakeFilter] = useState('open');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    setError('');
    try {
      const [overviewResponse, mistakeResponse] = await Promise.all([
        axios.get(`${API}/api/learning/overview`, { withCredentials: true }),
        axios.get(`${API}/api/learning/mistakes?status=${mistakeFilter}`, { withCredentials: true })
      ]);
      setOverview(overviewResponse.data);
      setMistakes(mistakeResponse.data.mistakes || []);
    } catch (loadError) {
      if (loadError.response?.status === 401) {
        setError('Please sign in and complete a generated quiz to build your learning history.');
      } else {
        setError(loadError.response?.data?.error || 'Learning analytics could not be loaded.');
      }
    } finally {
      setLoading(false);
    }
  }, [mistakeFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleLogout = async () => {
    try {
      await axios.post(`${API}/auth/logout`, {}, { withCredentials: true });
    } finally {
      window.location.href = '/';
    }
  };

  const reviewMistake = async mistake => {
    setBusyId(mistake.id);
    setError('');
    try {
      const response = await axios.post(
        `${API}/api/learning/mistakes/${mistake.id}/review`,
        {},
        { withCredentials: true }
      );
      await loadData();
      setError('');
    } catch (actionError) {
      setError(actionError.response?.data?.error || 'Could not schedule this mistake for review.');
    } finally {
      setBusyId(null);
    }
  };

  const resolveMistake = async mistake => {
    setBusyId(mistake.id);
    setError('');
    try {
      await axios.post(`${API}/api/learning/mistakes/${mistake.id}/resolve`, {}, { withCredentials: true });
      await loadData();
      setError('');
    } catch (actionError) {
      setError(actionError.response?.data?.error || 'Could not mark this mistake as learned.');
    } finally {
      setBusyId(null);
    }
  };

  const summary = overview?.summary || {};
  const topics = overview?.topics || [];
  const weakTopics = overview?.weakTopics || [];

  return (
    <div className="min-h-screen bg-[#0A1F2B] text-white" style={{ fontFamily: 'Inter, sans-serif' }}>
      <Sidebar onLogout={handleLogout} />
      <main className="md:ml-64 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-6xl">
          <header className="mb-8 rounded-2xl border border-[#2A4A57] bg-gradient-to-r from-[#123543] via-[#1E3A47] to-[#173044] p-6 md:p-8">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.25em] text-[#9AE9FD]">Adaptive learning</p>
            <h1 className="text-3xl font-black md:text-4xl">Your learning intelligence</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300 md:text-base">
              Mastery is based on verified answers from generated quizzes. Weak topics return sooner; stronger topics get longer review intervals.
            </p>
          </header>

          {error && <div role="alert" className="mb-5 rounded-xl border border-amber-500/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">{error}</div>}

          {loading ? (
            <div className="rounded-2xl border border-[#2A4A57] bg-[#122E3A] p-10 text-center text-slate-400">Loading your learning history…</div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { title: 'Average mastery', value: pct(summary.averageMastery), caption: `${summary.topicsTracked || 0} topics tracked` },
                  { title: 'Verified answers', value: summary.verifiedAnswers || 0, caption: 'From server-checked quizzes' },
                  { title: 'Open mistakes', value: summary.openMistakes || 0, caption: 'Saved for focused revision' },
                  { title: 'Reviews due', value: summary.dueMistakes || 0, caption: 'Mistakes ready to revisit' }
                ].map(item => (
                  <div key={item.title} className="rounded-2xl border border-[#2A4A57] bg-[#122E3A] p-5">
                    <p className="text-sm font-semibold text-slate-400">{item.title}</p>
                    <p className="mt-2 text-3xl font-black text-[#9AE9FD]">{item.value}</p>
                    <p className="mt-2 text-xs text-slate-500">{item.caption}</p>
                  </div>
                ))}
              </div>

              <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_1fr]">
                <section className="rounded-2xl border border-[#2A4A57] bg-[#122E3A] p-5 md:p-6">
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-bold text-[#9AE9FD]">Topic mastery</h2>
                      <p className="mt-1 text-sm text-slate-400">Accuracy is confidence-adjusted during the first five answers.</p>
                    </div>
                  </div>

                  {topics.length === 0 ? (
                    <div className="rounded-xl bg-[#0A1F2B] p-6 text-center">
                      <div className="mb-2 text-3xl">🎯</div>
                      <p className="font-semibold">Your mastery map is ready to grow</p>
                      <p className="mt-2 text-sm leading-6 text-slate-400">Complete a generated quiz in Battle Arena to record topic-tagged answers. Practice sets do not award points or affect mastery until their source is verified.</p>
                      <a href="/battlegrounds/lobby" className="mt-4 inline-flex rounded-lg bg-[#9AE9FD] px-4 py-2 text-sm font-bold text-[#002732]">Start a quiz</a>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {topics.map(topic => (
                        <div key={`${topic.subject}:${topic.topic}`} className="rounded-xl border border-[#2A4A57] bg-[#0A1F2B]/75 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-bold text-white">{topic.topic}</p>
                              <p className="mt-1 text-xs text-slate-400">{topic.subject} · {topic.attempts} verified answer(s) · {topic.correctCount} correct</p>
                            </div>
                            <span className="rounded-full bg-[#9AE9FD]/10 px-3 py-1 text-sm font-black text-[#9AE9FD]">{pct(topic.mastery)}</span>
                          </div>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-700">
                            <div className="h-full rounded-full bg-gradient-to-r from-[#7FB3C1] to-[#9AE9FD]" style={{ width: pct(topic.mastery) }} />
                          </div>
                          <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
                            <span>Accuracy: {pct(topic.accuracy)}</span>
                            <span>Review: {dateLabel(topic.nextReviewAt)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-[#2A4A57] bg-[#122E3A] p-5 md:p-6">
                  <div className="mb-5">
                    <h2 className="text-xl font-bold text-[#9AE9FD]">Mistake notebook</h2>
                    <p className="mt-1 text-sm text-slate-400">Incorrect answers become scheduled review items, not just a score.</p>
                  </div>

                  <div className="mb-4 inline-flex rounded-xl bg-[#071B24] p-1">
                    <button onClick={() => setMistakeFilter('open')} className={`rounded-lg px-3 py-2 text-sm font-bold ${mistakeFilter === 'open' ? 'bg-[#9AE9FD] text-[#002732]' : 'text-slate-400 hover:text-white'}`}>Open</button>
                    <button onClick={() => setMistakeFilter('resolved')} className={`rounded-lg px-3 py-2 text-sm font-bold ${mistakeFilter === 'resolved' ? 'bg-[#9AE9FD] text-[#002732]' : 'text-slate-400 hover:text-white'}`}>Learned</button>
                  </div>

                  {mistakes.length === 0 ? (
                    <div className="rounded-xl bg-[#0A1F2B] p-6 text-center">
                      <div className="mb-2 text-3xl">{mistakeFilter === 'open' ? '🌱' : '✨'}</div>
                      <p className="font-semibold">{mistakeFilter === 'open' ? 'No open mistakes yet' : 'No resolved mistakes yet'}</p>
                      <p className="mt-2 text-sm leading-6 text-slate-400">{mistakeFilter === 'open' ? 'Complete a generated quiz; incorrect answers appear here.' : 'Mark a mistake as learned after you can answer it confidently.'}</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {mistakes.map(mistake => (
                        <article key={mistake.id} className="rounded-xl border border-[#2A4A57] bg-[#0A1F2B]/75 p-4">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-md bg-[#9AE9FD]/10 px-2 py-1 font-bold text-[#9AE9FD]">{mistake.subject}</span>
                            <span className="text-slate-500">{mistake.topic}</span>
                            {mistake.status === 'open' && <span className="ml-auto text-slate-500">Review {dateLabel(mistake.nextReviewAt)}</span>}
                          </div>
                          <p className="mt-3 text-sm font-semibold leading-6 text-white">{mistake.question}</p>
                          <p className="mt-2 text-xs text-slate-400">Your answer: {mistake.selectedAnswer < 0 ? 'No answer' : mistake.options[mistake.selectedAnswer] || 'Unknown option'}</p>
                          <p className="mt-1 text-xs font-semibold text-emerald-300">Correct answer: {mistake.options[mistake.correctAnswer]}</p>
                          {mistake.status === 'open' && (
                            <div className="mt-4 flex flex-wrap gap-2">
                              <button disabled={busyId === mistake.id} onClick={() => reviewMistake(mistake)} className="rounded-lg border border-[#5B8795] px-3 py-2 text-xs font-bold text-[#9AE9FD] hover:bg-[#183B47] disabled:opacity-50">
                                {busyId === mistake.id ? 'Saving…' : 'Reviewed · schedule again'}
                              </button>
                              <button disabled={busyId === mistake.id} onClick={() => resolveMistake(mistake)} className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                                Mark learned
                              </button>
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {weakTopics.length > 0 && (
                <section className="mt-6 rounded-2xl border border-[#2A4A57] bg-[#122E3A] p-5 md:p-6">
                  <h2 className="text-lg font-bold text-[#9AE9FD]">Focus next</h2>
                  <p className="mt-1 text-sm text-slate-400">Your lowest mastery estimates are listed first.</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {weakTopics.map(topic => (
                      <span key={`weak:${topic.subject}:${topic.topic}`} className="rounded-full border border-[#365C69] px-3 py-2 text-sm text-slate-200">
                        {topic.topic} · {pct(topic.mastery)}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default LearningDashboard;
