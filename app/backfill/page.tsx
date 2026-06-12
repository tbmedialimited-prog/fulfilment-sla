"use client";

import { useState, useEffect, useRef } from "react";

interface BackfillResponse {
  done: boolean;
  next_url: string | null;
  next: { status: number; page: number } | null;
  fetched: number;
  inserted: number;
  updated: number;
  skipped_older_than_cutoff: number;
  last_seen_order_date: string | null;
  duration_ms: number;
  backfill_days: number;
}

interface RunStats {
  startedAt: Date;
  totalFetched: number;
  totalInserted: number;
  totalUpdated: number;
  totalSkipped: number;
  calls: number;
  earliestSeen: string | null;
  lastResponse: BackfillResponse | null;
  errors: string[];
  done: boolean;
}

export default function BackfillPage() {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<RunStats | null>(null);
  const stopRef = useRef(false);

  async function runOne(nextUrl: string): Promise<BackfillResponse | null> {
    try {
      const res = await fetch(nextUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      throw new Error(e?.message ?? String(e));
    }
  }

  async function start() {
    stopRef.current = false;
    setRunning(true);
    const s: RunStats = {
      startedAt: new Date(),
      totalFetched: 0,
      totalInserted: 0,
      totalUpdated: 0,
      totalSkipped: 0,
      calls: 0,
      earliestSeen: null,
      lastResponse: null,
      errors: [],
      done: false,
    };
    setStats({ ...s });

    let nextUrl = "/api/backfill";
    let calls = 0;
    while (!stopRef.current && calls < 50) {
      try {
        const resp = await runOne(nextUrl);
        if (!resp) break;
        s.calls += 1;
        s.totalFetched += resp.fetched || 0;
        s.totalInserted += resp.inserted || 0;
        s.totalUpdated += resp.updated || 0;
        s.totalSkipped += resp.skipped_older_than_cutoff || 0;
        if (resp.last_seen_order_date) s.earliestSeen = resp.last_seen_order_date;
        s.lastResponse = resp;
        s.done = !!resp.done;
        setStats({ ...s });
        calls += 1;
        if (resp.done || !resp.next_url) break;
        nextUrl = resp.next_url;
        // Small pause so we don't hammer
        await new Promise(r => setTimeout(r, 500));
      } catch (e: any) {
        s.errors.push(`Call ${calls + 1}: ${e?.message ?? e}`);
        setStats({ ...s });
        break;
      }
    }
    setRunning(false);
  }

  function stop() {
    stopRef.current = true;
    setRunning(false);
  }

  const elapsedSec = stats ? Math.floor((Date.now() - stats.startedAt.getTime()) / 1000) : 0;

  return (
    <div className="shell">
      <header className="top">
        <h1>
          Historical <em>backfill</em>
        </h1>
        <div className="meta">
          Pulls all dispatched orders from the past 30 days<br />
          across Mintsoft statuses 4, 5, 6 (Dispatched / Invoiced / Completed)
        </div>
      </header>

      <div style={{ display: "flex", gap: 12, marginBottom: 32, alignItems: "center" }}>
        {!running ? (
          <button className="refresh" onClick={start} style={{ fontSize: 14, padding: "10px 24px" }}>
            {stats?.done ? "Run again" : "Start backfill"}
          </button>
        ) : (
          <button className="refresh" onClick={stop} style={{ fontSize: 14, padding: "10px 24px", background: "var(--bad)" }}>
            Stop
          </button>
        )}
        <a href="/" style={{ fontSize: 13, color: "var(--ink-mute)" }}>← Back to dashboard</a>
      </div>

      {stats && (
        <>
          <div className="kpis" style={{ marginBottom: 24 }}>
            <div className="kpi accent">
              <div className="label">Orders Fetched</div>
              <div className="value">{stats.totalFetched.toLocaleString()}</div>
              <div className="sub">
                <span>{stats.calls} {stats.calls === 1 ? "call" : "calls"}</span>
                <span>{elapsedSec}s elapsed</span>
              </div>
            </div>
            <div className="kpi">
              <div className="label">New Orders</div>
              <div className="value pct-good">{stats.totalInserted.toLocaleString()}</div>
              <div className="sub">
                <span>{stats.totalUpdated.toLocaleString()} updated</span>
              </div>
            </div>
            <div className="kpi">
              <div className="label">Skipped (older than 30d)</div>
              <div className="value">{stats.totalSkipped.toLocaleString()}</div>
              <div className="sub">
                <span>past cutoff</span>
              </div>
            </div>
            <div className="kpi">
              <div className="label">Status</div>
              <div className="value" style={{ fontSize: 24, paddingTop: 6 }}>
                {running ? "Running…" : stats.done ? "✓ Done" : "Stopped"}
              </div>
              <div className="sub">
                <span>{stats.errors.length > 0 ? `${stats.errors.length} error(s)` : "no errors"}</span>
              </div>
            </div>
          </div>

          {stats.earliestSeen && (
            <div style={{ fontSize: 12, color: "var(--ink-mute)", marginBottom: 20, fontFamily: "monospace" }}>
              Earliest order date seen: <strong>{stats.earliestSeen}</strong>
            </div>
          )}

          {stats.lastResponse && (
            <>
              <h2 className="section">Last call <small>response from /api/backfill</small></h2>
              <div className="table-wrap" style={{ padding: 20 }}>
                <pre style={{ margin: 0, fontSize: 12, fontFamily: "JetBrains Mono, monospace", whiteSpace: "pre-wrap", color: "var(--ink-soft)" }}>
                  {JSON.stringify(stats.lastResponse, null, 2)}
                </pre>
              </div>
            </>
          )}

          {stats.errors.length > 0 && (
            <>
              <h2 className="section" style={{ color: "var(--bad)" }}>Errors</h2>
              <div className="table-wrap" style={{ padding: 20 }}>
                {stats.errors.map((e, i) => (
                  <div key={i} style={{ fontFamily: "monospace", fontSize: 12, color: "var(--bad)", marginBottom: 4 }}>{e}</div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
