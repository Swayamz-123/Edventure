import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import Sidebar from './SideBar';

const API = import.meta.env.VITE_BACKEND_URL;

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function DocumentTutor() {
  const [documents, setDocuments] = useState([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState([]);
  const [file, setFile] = useState(null);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pdfJsReady, setPdfJsReady] = useState(Boolean(window.pdfjsLib));

  const readyDocuments = useMemo(
    () => documents.filter(document => document.status === 'ready'),
    [documents]
  );
  const processingDocuments = useMemo(
    () => documents.some(document => document.status === 'processing'),
    [documents]
  );

  const loadDocuments = useCallback(async () => {
    try {
      const response = await axios.get(`${API}/api/documents`, { withCredentials: true });
      const nextDocuments = response.data.documents || [];
      setDocuments(nextDocuments);
      setSelectedDocumentIds(previous => {
        const readyIds = new Set(nextDocuments.filter(doc => doc.status === 'ready').map(doc => doc.id));
        const stillSelected = previous.filter(id => readyIds.has(id));
        return stillSelected.length ? stillSelected : nextDocuments.filter(doc => doc.status === 'ready').map(doc => doc.id);
      });
    } catch (loadError) {
      if (loadError.response?.status === 401) {
        setError('Please log in before uploading study material.');
      } else {
        setError('Could not load your study materials. Check the backend connection and try again.');
      }
    } finally {
      setLoadingDocuments(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';
      setPdfJsReady(true);
      return undefined;
    }

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.min.js';
    script.async = true;
    script.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';
        setPdfJsReady(true);
      } else {
        setError('The PDF processing library could not be initialized.');
      }
    };
    script.onerror = () => setError('Could not load PDF.js. Check your connection and retry.');
    document.head.appendChild(script);
    return () => {
      if (script.parentNode) script.parentNode.removeChild(script);
    };
  }, []);

  useEffect(() => {
    if (!processingDocuments) return undefined;
    const intervalId = window.setInterval(loadDocuments, 2500);
    return () => window.clearInterval(intervalId);
  }, [processingDocuments, loadDocuments]);

  const handleLogout = async () => {
    try {
      await axios.post(`${API}/auth/logout`, {}, { withCredentials: true });
    } catch (_error) {
      // The local navigation still ends the visible session.
    } finally {
      window.location.href = '/';
    }
  };

  const handleUpload = async event => {
    event.preventDefault();
    setError('');
    setNotice('');
    setAnswer('');
    setSources([]);

    if (!file) {
      setError('Choose a PDF file first.');
      return;
    }
    if (!pdfJsReady || !window.pdfjsLib) {
      setError('PDF processing is still loading. Please try again in a moment.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError('Please upload a PDF smaller than 8 MB.');
      return;
    }

    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      if (pdf.numPages < 1 || pdf.numPages > 80) {
        throw new Error('PDFs must have 1–80 pages.');
      }

      const pages = [];
      let characterCount = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const pageContent = await page.getTextContent();
        const pageText = pageContent.items
          .map(item => typeof item.str === 'string' ? item.str : '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        characterCount += pageText.length;
        if (characterCount > 120000) {
          throw new Error('Extracted text exceeds 120,000 characters. Try a smaller or shorter PDF.');
        }
        pages.push({ pageNumber, text: pageText });
      }

      if (characterCount < 100) {
        throw new Error('No selectable text was found. Scanned/image-only PDFs are not supported yet.');
      }

      const response = await axios.post(
        `${API}/api/documents`,
        { title: file.name.replace(/\.pdf$/i, '').slice(0, 120), pages },
        { withCredentials: true, timeout: 30000 }
      );
      const created = response.data.document;
      setNotice(`"${created.title}" is queued for indexing. You can ask questions once its status becomes Ready.`);
      setFile(null);
      event.target.reset();
      await loadDocuments();
    } catch (uploadError) {
      setError(uploadError.response?.data?.error || uploadError.message || 'Could not index this PDF.');
    } finally {
      setUploading(false);
    }
  };

  const toggleDocument = id => {
    setSelectedDocumentIds(previous =>
      previous.includes(id) ? previous.filter(existing => existing !== id) : [...previous, id]
    );
  };

  const deleteDocument = async document => {
    setError('');
    setNotice('');
    try {
      await axios.delete(`${API}/api/documents/${document.id}`, { withCredentials: true });
      setDocuments(previous => previous.filter(item => item.id !== document.id));
      setSelectedDocumentIds(previous => previous.filter(id => id !== document.id));
      setNotice(`Deleted "${document.title}" and its indexed chunks.`);
    } catch (deleteError) {
      setError(deleteError.response?.data?.error || 'Could not delete the selected document.');
    }
  };

  const askTutor = async event => {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 4) {
      setError('Enter a question with at least 4 characters.');
      return;
    }
    if (!readyDocuments.length) {
      setError('Wait for a document to finish indexing before asking ERA.');
      return;
    }

    setAsking(true);
    setError('');
    setNotice('');
    setAnswer('');
    setSources([]);
    try {
      const payload = { question: trimmed };
      if (selectedDocumentIds.length > 0) payload.documentIds = selectedDocumentIds;
      const response = await axios.post(`${API}/api/tutor/ask`, payload, {
        withCredentials: true,
        timeout: 60000
      });
      setAnswer(response.data.answer || 'No answer was returned.');
      setSources(response.data.sources || []);
    } catch (askError) {
      setError(askError.response?.data?.error || 'ERA could not answer this question. Please retry.');
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A1F2B] text-white" style={{ fontFamily: 'Inter, sans-serif' }}>
      <Sidebar onLogout={handleLogout} />
      <main className="md:ml-64 px-4 py-8 md:px-8">
        <div className="mx-auto max-w-6xl">
          <header className="mb-8 rounded-2xl border border-[#2A4A57] bg-gradient-to-r from-[#123543] via-[#1E3A47] to-[#173044] p-6 md:p-8">
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.25em] text-[#9AE9FD]">ERA · Grounded AI</p>
            <h1 className="text-3xl font-black md:text-4xl">Study with your own materials</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300 md:text-base">
              Upload a text-based PDF, let ERA index the passages, and ask questions with page-linked source citations.
              Your indexed documents are private to your account.
            </p>
          </header>

          {error && <div role="alert" className="mb-4 rounded-xl border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">{error}</div>}
          {notice && <div role="status" className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-950/25 px-4 py-3 text-sm text-emerald-200">{notice}</div>}

          <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
            <section className="rounded-2xl border border-[#2A4A57] bg-[#122E3A] p-5 md:p-6">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-[#9AE9FD]">Your study library</h2>
                  <p className="mt-1 text-xs text-slate-400">PDF · up to 8 MB · 80 pages</p>
                </div>
                <span className="rounded-full bg-[#9AE9FD]/10 px-3 py-1 text-xs font-bold text-[#9AE9FD]">{readyDocuments.length} ready</span>
              </div>

              <form onSubmit={handleUpload} className="mb-6 rounded-xl border border-dashed border-[#5B8795] bg-[#08212B]/70 p-4">
                <label className="mb-2 block text-sm font-semibold text-slate-200" htmlFor="study-pdf">Choose a text-based PDF</label>
                <input
                  id="study-pdf"
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={event => setFile(event.target.files?.[0] || null)}
                  className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-[#9AE9FD] file:px-3 file:py-2 file:font-bold file:text-[#002732] hover:file:bg-white"
                />
                {file && <p className="mt-2 text-xs text-slate-400">{file.name} · {formatBytes(file.size)}</p>}
                <button
                  type="submit"
                  disabled={uploading || !pdfJsReady}
                  className="mt-4 w-full rounded-xl bg-[#9AE9FD] px-4 py-3 text-sm font-black text-[#002732] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {uploading ? 'Extracting and indexing…' : pdfJsReady ? 'Index study material' : 'Loading PDF support…'}
                </button>
                <p className="mt-3 text-xs leading-5 text-slate-400">
                  Text extraction happens in your browser; extracted text is sent over HTTPS to index it. Scanned PDFs need OCR, which is not enabled in this version.
                </p>
              </form>

              <div className="space-y-3">
                {loadingDocuments ? (
                  <p className="py-5 text-center text-sm text-slate-400">Loading your library…</p>
                ) : documents.length === 0 ? (
                  <div className="rounded-xl bg-[#0A1F2B] p-5 text-center">
                    <div className="mb-2 text-3xl">📚</div>
                    <p className="font-semibold text-slate-200">No study material yet</p>
                    <p className="mt-1 text-sm text-slate-400">Upload your first PDF to create your private knowledge base.</p>
                  </div>
                ) : documents.map(document => (
                  <div key={document.id} className="rounded-xl border border-[#2A4A57] bg-[#0A1F2B]/80 p-4">
                    <div className="flex items-start gap-3">
                      {document.status === 'ready' ? (
                        <input
                          aria-label={`Use ${document.title} as a source`}
                          type="checkbox"
                          checked={selectedDocumentIds.includes(document.id)}
                          onChange={() => toggleDocument(document.id)}
                          className="mt-1 h-4 w-4 accent-cyan-300"
                        />
                      ) : <span className="mt-1 inline-block h-4 w-4 rounded-full border-2 border-[#5B8795]" />}
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-semibold text-white">{document.title}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {document.pageCount || 0} pages · {document.chunkCount || 0} chunks
                        </p>
                        <p className={`mt-2 text-xs font-semibold ${document.status === 'ready' ? 'text-emerald-300' : document.status === 'failed' ? 'text-red-300' : 'text-amber-300'}`}>
                          {document.status === 'ready' ? 'Ready to search' : document.status === 'failed' ? 'Indexing failed' : 'Indexing in background…'}
                        </p>
                        {document.statusMessage && <p className="mt-1 text-xs text-slate-400">{document.statusMessage}</p>}
                      </div>
                      <button onClick={() => deleteDocument(document)} type="button" className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-slate-400 hover:bg-red-950/40 hover:text-red-300">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-[#2A4A57] bg-[#122E3A] p-5 md:p-6">
              <div className="mb-5">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#9AE9FD]">Ask ERA</p>
                <h2 className="mt-2 text-xl font-bold">Answers grounded in your notes</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">Choose one or more indexed documents. ERA retrieves relevant passages and includes page references you can check.</p>
              </div>

              <form onSubmit={askTutor}>
                <label htmlFor="era-question" className="mb-2 block text-sm font-semibold text-slate-200">What would you like to understand?</label>
                <textarea
                  id="era-question"
                  value={question}
                  onChange={event => setQuestion(event.target.value)}
                  rows={4}
                  maxLength={3000}
                  placeholder="Explain the difference between process and thread using my notes…"
                  className="w-full resize-y rounded-xl border border-[#365C69] bg-[#071B24] px-4 py-3 text-sm leading-6 text-white outline-none placeholder:text-slate-500 focus:border-[#9AE9FD]"
                />
                <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                  <span>{selectedDocumentIds.length ? `${selectedDocumentIds.length} source document(s) selected` : 'All ready documents will be searched'}</span>
                  <span>{question.length}/3000</span>
                </div>
                <button
                  type="submit"
                  disabled={asking || !readyDocuments.length}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#9AE9FD] to-[#7FB3C1] px-4 py-3 font-black text-[#002732] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {asking ? 'Retrieving passages and reasoning…' : 'Ask ERA'}
                </button>
              </form>

              {(answer || asking) && (
                <div className="mt-6 rounded-xl border border-[#365C69] bg-[#071B24] p-4 md:p-5">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#9AE9FD]/15 text-lg">✦</span>
                    <h3 className="font-bold text-[#9AE9FD]">ERA's response</h3>
                  </div>
                  {asking ? (
                    <div className="space-y-2">
                      <div className="h-3 w-full animate-pulse rounded bg-slate-700" />
                      <div className="h-3 w-5/6 animate-pulse rounded bg-slate-700" />
                      <div className="h-3 w-2/3 animate-pulse rounded bg-slate-700" />
                    </div>
                  ) : <p className="whitespace-pre-wrap text-sm leading-7 text-slate-100">{answer}</p>}

                  {!asking && sources.length > 0 && (
                    <div className="mt-6 border-t border-[#2A4A57] pt-4">
                      <h4 className="mb-3 text-sm font-bold text-slate-200">Retrieved sources</h4>
                      <div className="space-y-3">
                        {sources.map(source => (
                          <div key={source.sourceId} className="rounded-lg border border-[#2A4A57] bg-[#102D38] p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="rounded-md bg-[#9AE9FD]/15 px-2 py-1 text-xs font-black text-[#9AE9FD]">{source.sourceId}</span>
                              <span className="text-xs text-slate-400">Page {source.pageNumber}</span>
                            </div>
                            <p className="mt-2 text-sm font-semibold text-white">{source.title}</p>
                            <p className="mt-2 text-xs leading-5 text-slate-300">{source.excerpt}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

export default DocumentTutor;
