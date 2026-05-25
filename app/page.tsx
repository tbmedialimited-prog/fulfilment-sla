"use client";

import { useEffect, useState, useMemo, useCallback } from "react";

type Summary = {
  total_orders: number;
  dispatched: number;
  delivered: number;
  in_transit: number;
  warehouse_sla: { eligible: number; met: number; rate: number | null };
  delivery_sla: { eligible: number; met: number; rate: number | null };
  transit_hours: { n: number; mean: number | null; median: number | null; p90: number | null };
};

type ClientRow = {
  client: string;
  total_orders: number;
  dispatched: number;
  delivered: number;
  warehouse_sla_rate: number | null;
  delivery_sla_rate: number | null;
  median_transit_hours: number | null;
  p90_transit_hours: number | null;
};

type OrderRow = {
  id: number;
  order_number: string;
  client: string;
  courier: string | null;
  tracking_number: string | null;
  postcode: string | null;
  country: string | null;
  order_date: string;
  despatch_date: string | null;
  delivered_date: string | null;
  warehouse_sla_met: boolean | null;
  delivery_sla_met: boolean | null;
  transit_hours: number | null;
  tracking_status: string | null;
  last_event: string | null;
};

function pctClass(rate: number | null): string {
  if (rate === null) return "none";
  if (rate >= 95) return "good";
  if (rate >= 85) return "warn";
  return "bad";
}

function fmtPct(rate: number | null): string {
  if (rate === null) return "—";
  return `${rate}%`;
}

function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  try {
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString("en-GB", {
      timeZone: "Europe/London",
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch { return s; }
}

function courierTag(courier: string | null): { label: string; klass: string } {
  if (!courier) return { label: "—", klass: "other" };
  const lower = courier.toLowerCase();
  if (lower.includes("dpd")) return { label: "DPD", klass: "dpd" };
  if (lower.includes("royal mail")) return { label: "RM", klass: "rm" };
  return { label: courier.split(" ").slice(0, 2).join(" "), klass: "other" };
}

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const [courierFilter, setCourierFilter] = useState<string>("");
  const [clientFilter, setClientFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [byClient, setByClient] = useState<ClientRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("days", String(days));
      if (courierFilter) params.set("courier", courierFilter);
      if (clientFilter) params.set("client", clientFilter);

      const [sumRes, byCRes, ordRes] = await Promise.all([
        fetch(`/api/summary?${params}`).then(r => r.json()),
        fetch(`/api/by-client?${new URLSearchParams({ days: String(days), ...(courierFilter && { courier: courierFilter }) })}`).then(r => r.json()),
        fetch(`/api/orders?${params}&limit=100`).then(r => r.json()),
      ]);
      setSummary(sumRes);
      setByClient(byCRes);
      setOrders(ordRes.orders ?? []);
      setTotalOrders(ordRes.total ?? 0);
      setLastUpdated(new Date());
    } catch (e) {
      console.error("Load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [days, courierFilter, clientFilter]);

  const triggerSync = async () => {
    setRefreshing(true);
    setSyncMessage("Syncing from Mintsoft + DPD...");
    try {
      const res = await fetch("/api/cron");
      const data = await res.json();
      if (data.mintsoft_error || data.dpd_error) {
        setSyncMessage(`⚠ ${data.mintsoft_error || data.dpd_error}`);
      } else {
        const m = data.mintsoft || {};
        const d = data.dpd || {};
        setSyncMessage(`✓ Fetched ${m.fetched ?? 0} orders, ${m.inserted ?? 0} new. DPD tracked ${d.checked ?? 0}.`);
      }
      await load();
    } catch (e: any) {
      setSyncMessage(`Sync failed: ${e?.message ?? e}`);
    } finally {
      setRefreshing(false);
      setTimeout(() => setSyncMessage(null), 8000);
    }
  };

  useEffect(() => { load(); }, [load]);

  const clientOptions = useMemo(() => {
    const set = new Set(byClient.map(c => c.client));
    return Array.from(set).sort();
  }, [byClient]);

  return (
    <div className="shell">
      <header className="top">
        <h1>
          Warehouse <em>SLA</em>
        </h1>
        <div className="meta">
          {lastUpdated && <>Last loaded: <strong>{lastUpdated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong><br /></>}
          Auto-sync hourly · {totalOrders} orders in view<br />
          {syncMessage && <strong style={{ color: syncMessage.startsWith("⚠") || syncMessage.startsWith("Sync failed") ? "var(--bad)" : "var(--good)" }}>{syncMessage}</strong>}
        </div>
      </header>

      <div className="filters">
        <div className="filter-group">
          {[7, 14, 30, 90].map(d => (
            <button key={d} className={days === d ? "active" : ""} onClick={() => setDays(d)}>{d}d</button>
          ))}
        </div>
        <div className="filter-group">
          <button className={!courierFilter ? "active" : ""} onClick={() => setCourierFilter("")}>All carriers</button>
          <button className={courierFilter === "dpd" ? "active" : ""} onClick={() => setCourierFilter("dpd")}>DPD only</button>
          <button className={courierFilter === "royal mail" ? "active" : ""} onClick={() => setCourierFilter("royal mail")}>Royal Mail</button>
        </div>
        {clientOptions.length > 0 && (
          <select className="filter" value={clientFilter} onChange={e => setClientFilter(e.target.value)}>
            <option value="">All clients</option>
            {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <button className="refresh" onClick={triggerSync} disabled={refreshing}>
          {refreshing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {loading && !summary && <div className="loading">Loading…</div>}

      {summary && (
        <>
          <div className="kpis">
            <div className="kpi accent">
              <div className="label">Warehouse SLA</div>
              <div className="value">
                {fmtPct(summary.warehouse_sla.rate)}
              </div>
              <div className="sub">
                <span>{summary.warehouse_sla.met} of {summary.warehouse_sla.eligible} on time</span>
                <span>before 1pm cut-off</span>
              </div>
            </div>
            <div className="kpi">
              <div className="label">Delivery SLA (DPD)</div>
              <div className={`value ${pctClass(summary.delivery_sla.rate) === "good" ? "pct-good" : pctClass(summary.delivery_sla.rate) === "warn" ? "pct-warn" : "pct-bad"}`}>
                {fmtPct(summary.delivery_sla.rate)}
              </div>
              <div className="sub">
                <span>{summary.delivery_sla.met} of {summary.delivery_sla.eligible} on time</span>
                <span>next working day</span>
              </div>
            </div>
            <div className="kpi">
              <div className="label">Median Transit</div>
              <div className="value">
                {summary.transit_hours.median ?? "—"}<small>{summary.transit_hours.median != null ? "h" : ""}</small>
              </div>
              <div className="sub">
                <span>P90: {summary.transit_hours.p90 ?? "—"}{summary.transit_hours.p90 != null ? "h" : ""}</span>
                <span>{summary.transit_hours.n} delivered</span>
              </div>
            </div>
            <div className="kpi">
              <div className="label">Orders in Window</div>
              <div className="value">{summary.total_orders}</div>
              <div className="sub">
                <span>{summary.dispatched} dispatched</span>
                <span>{summary.in_transit} in transit</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Per-client */}
      <h2 className="section">
        Per Client <small>{byClient.length} clients · last {days} days</small>
      </h2>
      <div className="table-wrap">
        {byClient.length === 0 ? (
          <div className="empty">
            <h3>No orders yet</h3>
            <p>Click <code>Sync now</code> to pull orders from Mintsoft.</p>
            <p>If that fails, check environment variables in Vercel: <code>MINTSOFT_API_KEY</code>, <code>KV_REST_API_URL</code>, <code>KV_REST_API_TOKEN</code>.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th className="num">Orders</th>
                <th className="num">Dispatched</th>
                <th className="num">Delivered</th>
                <th className="num">Warehouse SLA</th>
                <th className="num">Delivery SLA</th>
                <th className="num">Med transit</th>
                <th className="num">P90</th>
              </tr>
            </thead>
            <tbody>
              {byClient.map(c => (
                <tr key={c.client}>
                  <td className="client">{c.client}</td>
                  <td className="num">{c.total_orders}</td>
                  <td className="num">{c.dispatched}</td>
                  <td className="num">{c.delivered}</td>
                  <td className="num"><span className={`pct-pill ${pctClass(c.warehouse_sla_rate)}`}>{fmtPct(c.warehouse_sla_rate)}</span></td>
                  <td className="num"><span className={`pct-pill ${pctClass(c.delivery_sla_rate)}`}>{fmtPct(c.delivery_sla_rate)}</span></td>
                  <td className="num">{c.median_transit_hours ?? "—"}{c.median_transit_hours != null ? "h" : ""}</td>
                  <td className="num dim">{c.p90_transit_hours ?? "—"}{c.p90_transit_hours != null ? "h" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent orders */}
      <h2 className="section">
        Recent Orders <small>{orders.length} of {totalOrders} shown</small>
      </h2>
      <div className="table-wrap">
        {orders.length === 0 ? (
          <div className="empty">
            <p>No orders match the filters.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Client</th>
                <th>Carrier</th>
                <th>Postcode</th>
                <th>Ordered</th>
                <th>Despatched</th>
                <th>Delivered</th>
                <th>WH</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const ct = courierTag(o.courier);
                return (
                  <tr key={o.id}>
                    <td className="client">{o.order_number}</td>
                    <td>{o.client}</td>
                    <td><span className={`tag ${ct.klass}`}>{ct.label}</span></td>
                    <td className="mono dim" style={{ fontSize: 11 }}>{o.postcode ?? "—"}</td>
                    <td className="dim">{fmtDateTime(o.order_date)}</td>
                    <td className="dim">{fmtDateTime(o.despatch_date)}</td>
                    <td className="dim">{fmtDateTime(o.delivered_date)}</td>
                    <td>{o.warehouse_sla_met === true ? <span className="tag met">✓</span> : o.warehouse_sla_met === false ? <span className="tag miss">✗</span> : <span className="tag pending">—</span>}</td>
                    <td>{o.delivery_sla_met === true ? <span className="tag met">✓</span> : o.delivery_sla_met === false ? <span className="tag miss">✗</span> : <span className="tag pending">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
