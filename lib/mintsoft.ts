// Mintsoft API client - confirmed working with ms-apikey header
// Endpoints learned from real Make scenarios + testing

const MINTSOFT_BASE = "https://api.mintsoft.co.uk";

export interface MintsoftOrder {
  ID: number;
  OrderNumber: string;
  ClientId: number;
  CourierServiceName: string | null;
  TrackingNumber: string | null;
  Country?: { Code: string; Name: string };
  PostCode?: string;
  OrderDate: string; // ISO
  DespatchDate: string | null;
  OrderStatusId: number;
  // Many more fields, but these are what we use
}

async function mintsoftRequest<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const apiKey = process.env.MINTSOFT_API_KEY;
  if (!apiKey) throw new Error("MINTSOFT_API_KEY not set");

  const url = new URL(MINTSOFT_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      "ms-apikey": apiKey,
      "Accept": "application/json",
    },
    // Vercel edge runtime doesn't need this but it's clean
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mintsoft ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch orders by a specific status. Mintsoft requires OrderStatusId filter.
 */
async function fetchOrdersByStatus(statusId: number, pageSize = 200, page = 1): Promise<MintsoftOrder[]> {
  const data = await mintsoftRequest<MintsoftOrder[] | { Results?: MintsoftOrder[] }>(
    "/api/Order/List",
    {
      PageSize: pageSize,
      PageNumber: page,
      OrderStatusId: statusId,
    }
  );
  if (Array.isArray(data)) return data;
  return (data as any).Results ?? [];
}

/**
 * Pull dispatched orders across all relevant statuses.
 * Mintsoft lifecycle: New(1) -> Printed(2) -> Picked(3) -> Dispatched(4) -> Invoiced(5) -> Completed(6).
 * Once dispatched, orders move on to Invoiced/Completed quickly, so filtering only by
 * status=4 loses everything from yesterday onwards.
 *
 * We fetch all "post-dispatch" statuses (4, 5, 6) and only keep orders with a DespatchDate.
 * Returns deduplicated orders by ID.
 */
export async function fetchDispatchedOrders(opts: { pageSize?: number; page?: number } = {}): Promise<MintsoftOrder[]> {
  const pageSize = opts.pageSize ?? 200;
  const page = opts.page ?? 1;

  // Statuses to pull. Override via env var if Mintsoft uses different IDs.
  const statusIdsRaw = process.env.MINTSOFT_DISPATCHED_STATUSES || "4,5,6";
  const statusIds = statusIdsRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

  const seen = new Set<number>();
  const out: MintsoftOrder[] = [];

  for (const sid of statusIds) {
    try {
      const orders = await fetchOrdersByStatus(sid, pageSize, page);
      for (const o of orders) {
        if (!o.ID || seen.has(o.ID)) continue;
        // Only keep orders that have actually been dispatched
        if (!o.DespatchDate) continue;
        seen.add(o.ID);
        out.push(o);
      }
    } catch (e) {
      console.warn(`Mintsoft status=${sid} fetch failed:`, e);
      // Continue with other statuses
    }
  }
  return out;
}

/**
 * Diagnostic: fetch a small sample from various statuses to discover what IDs exist.
 */
export async function discoverStatuses(): Promise<{ statusId: number; count: number; sample?: any }[]> {
  const results: { statusId: number; count: number; sample?: any }[] = [];
  // Check statuses 1 through 30 to be thorough
  for (let sid = 1; sid <= 30; sid++) {
    try {
      const orders = await fetchOrdersByStatus(sid, 5, 1);
      if (orders.length > 0) {
        results.push({
          statusId: sid,
          count: orders.length,
          sample: {
            ID: orders[0].ID,
            OrderNumber: orders[0].OrderNumber,
            OrderDate: orders[0].OrderDate,
            DespatchDate: orders[0].DespatchDate,
            OrderStatusId: orders[0].OrderStatusId,
            CourierServiceName: orders[0].CourierServiceName,
          },
        });
      }
    } catch (e: any) {
      results.push({ statusId: sid, count: -1, sample: { error: String(e?.message ?? e).slice(0, 200) } });
    }
  }
  return results;
}

/**
 * Page-by-page fetch for a single status. Returns one page of results.
 * Caller controls pagination + when to stop (e.g. on date cutoff).
 */
export async function fetchOrdersPage(statusId: number, page: number, pageSize = 200): Promise<MintsoftOrder[]> {
  return fetchOrdersByStatus(statusId, pageSize, page);
}

/**
 * Fetch order detail (richer payload than List).
 */
export async function fetchOrderDetail(orderId: number): Promise<MintsoftOrder | null> {
  try {
    return await mintsoftRequest<MintsoftOrder>(`/api/Order/${orderId}`);
  } catch (e) {
    console.warn(`Failed to fetch order ${orderId}:`, e);
    return null;
  }
}

/**
 * Fetch list of clients to map ClientId -> ClientName
 */
export interface MintsoftClient {
  ID: number;
  Name: string;
  BrandName?: string;
}

export async function fetchClients(): Promise<MintsoftClient[]> {
  try {
    const data = await mintsoftRequest<MintsoftClient[]>("/api/Client");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
