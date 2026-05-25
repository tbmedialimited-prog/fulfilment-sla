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
 * Fetch dispatched orders. We use OrderStatusId=4 (Dispatched) which is the
 * status confirmed by inspecting your real Mintsoft data.
 */
export async function fetchDispatchedOrders(opts: { pageSize?: number; page?: number } = {}): Promise<MintsoftOrder[]> {
  const pageSize = opts.pageSize ?? 200;
  const page = opts.page ?? 1;
  const data = await mintsoftRequest<MintsoftOrder[] | { Results?: MintsoftOrder[] }>(
    "/api/Order/List",
    {
      PageSize: pageSize,
      PageNumber: page,
      OrderStatusId: 4,
    }
  );
  if (Array.isArray(data)) return data;
  return data.Results ?? [];
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
