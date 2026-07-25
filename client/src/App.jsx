import { useState } from 'react';
import { auditUrl } from './api.js';

function PulseLine() {
  // Signature element: an ECG-style trace that reads as a "vital sign" for a page.
  return (
    <svg className="pulse" viewBox="0 0 600 80" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points="0,40 120,40 150,40 165,12 185,68 205,40 240,40 260,28 280,52 300,40 600,40"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Vital({ label, value, tone }) {
  return (
    <div className={`vital vital--${tone || 'neutral'}`}>
      <span className="vital__label">{label}</span>
      <span className="vital__value">{value}</span>
    </div>
  );
}

function statusTone(code) {
  if (code >= 200 && code < 300) return 'good';
  if (code >= 300 && code < 400) return 'info';
  return 'bad';
}

function Results({ data }) {
  const s = data.securityHeaders || {};
  const secPresent = Object.values(s).filter(Boolean).length;
  const secTotal = Object.keys(s).length;

  return (
    <section className="results" aria-live="polite">
      <div className="results__head">
        <div>
          <div className="results__url">{data.finalUrl}</div>
          {data.finalUrl !== data.requestedUrl && (
            <div className="results__redirected">redirected from {data.requestedUrl}</div>
          )}
        </div>
        {data.cached && <span className="badge">cached</span>}
      </div>

      <div className="vitals">
        <Vital label="Status" value={data.statusCode} tone={statusTone(data.statusCode)} />
        <Vital label="Response time" value={`${data.timing.totalMs} ms`} tone="neutral" />
        <Vital
          label="Transport"
          value={data.transport.https ? 'HTTPS' : 'HTTP'}
          tone={data.transport.https ? 'good' : 'bad'}
        />
        <Vital label="Redirects" value={data.redirectCount} tone={data.redirectCount ? 'info' : 'neutral'} />
        <Vital
          label="Security headers"
          value={`${secPresent} / ${secTotal}`}
          tone={secPresent >= secTotal - 1 ? 'good' : secPresent === 0 ? 'bad' : 'info'}
        />
        <Vital label="Size" value={formatBytes(data.response.contentLengthBytes)} tone="neutral" />
      </div>

      {data.seo?.isHtml && (
        <div className="panel">
          <h3>On-page signals</h3>
          <dl className="kv">
            <dt>Title</dt>
            <dd>{data.seo.title || <em>missing</em>}</dd>
            <dt>Meta description</dt>
            <dd>{data.seo.metaDescription || <em>missing</em>}</dd>
            <dt>H1 tags</dt>
            <dd>{data.seo.h1Count}</dd>
          </dl>
        </div>
      )}

      {data.redirectChain?.length > 0 && (
        <div className="panel">
          <h3>Redirect chain</h3>
          <ol className="chain">
            {data.redirectChain.map((hop, i) => (
              <li key={i}>
                <span className="chain__status">{hop.status}</span> {hop.url}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);

  async function run() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await auditUrl(trimmed);
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <main className="wrap">
        <header className="hero">
          <div className="brand">
            Page<span className="brand__accent">Pulse</span>
          </div>
          <div className="pulse-wrap">
            <PulseLine />
          </div>
          <p className="tagline">Take the pulse of any page — status, speed, security and signals.</p>
        </header>

        <div className="bar">
          <input
            className="bar__input"
            type="url"
            inputMode="url"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            aria-label="URL to audit"
          />
          <button className="bar__btn" onClick={run} disabled={loading || !url.trim()}>
            {loading ? 'Auditing…' : 'Audit'}
          </button>
        </div>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {data && <Results data={data} />}
      </main>

      <footer className="footer">
        Built for{' '}
        <a href="https://digitalheroesco.com" target="_blank" rel="noopener noreferrer">
          Digital Heroes Training Task
        </a>
      </footer>
    </div>
  );
}
