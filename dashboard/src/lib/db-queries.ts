import { prisma } from './prisma';

export interface OverviewStats {
  callsToday: number;
  callsAllTime: number;
  conversionToday: number;
  conversionAllTime: number;
  activeNow: number;
  outboundLast7d: number;
  inboundLast7d: number;
  avgDurationTodaySec: number;
  /** Total time-on-call summed across every persisted call, in seconds. */
  totalDurationAllTimeSec: number;
  topObjectionTypes: Array<{ type: string; count: number }>;
  /** Mapped to Serena's `Product` table — top product IDs by call volume,
   *  with the converted count alongside. */
  topProducts: Array<{ productId: string; count: number; converted: number }>;
  topTools: Array<{ name: string; count: number }>;
  dailySeries: Array<{ day: string; total: number; converted: number }>;
  hourlyDensity: Array<{ hour: number; count: number }>;
  sentimentMix7d: { positive: number; neutral: number; negative: number };
}

export async function loadOverviewStats(): Promise<OverviewStats> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  type DailyRow = { day: Date; total: bigint; converted: bigint };
  type HourRow = { hour: number; n: bigint };

  const [
    callsToday,
    callsAllTime,
    convertedToday,
    convertedAllTime,
    activeNow,
    last7d,
    objections,
    durationRows,
    products,
    tools,
    sentimentRows,
    dailyRowsRaw,
    hourRowsRaw,
    totalDurationAgg,
  ] = await Promise.all([
    prisma.call.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.call.count(),
    prisma.call.count({
      where: { createdAt: { gte: startOfDay }, outcome: 'CONVERTED' },
    }),
    prisma.call.count({ where: { outcome: 'CONVERTED' } }),
    prisma.call.count({ where: { endedAt: null, createdAt: { gte: sevenDaysAgo } } }),
    prisma.call.findMany({
      where: { createdAt: { gte: sevenDaysAgo } },
      select: { id: true, productId: true },
    }),
    prisma.callTurn.groupBy({
      by: ['objectionType'],
      where: {
        createdAt: { gte: sevenDaysAgo },
        objectionType: { not: null },
        speaker: 'USER',
      },
      _count: { objectionType: true },
      orderBy: { _count: { objectionType: 'desc' } },
      take: 5,
    }),
    prisma.call.findMany({
      where: {
        createdAt: { gte: startOfDay },
        durationSeconds: { not: null },
      },
      select: { durationSeconds: true },
    }),
    prisma.call.groupBy({
      by: ['productId'],
      where: {
        createdAt: { gte: sevenDaysAgo },
        productId: { not: null },
      },
      _count: { productId: true },
      orderBy: { _count: { productId: 'desc' } },
      take: 5,
    }),
    prisma.callTurn.groupBy({
      by: ['toolCalled'],
      where: {
        createdAt: { gte: sevenDaysAgo },
        toolCalled: { not: null },
      },
      _count: { toolCalled: true },
      orderBy: { _count: { toolCalled: 'desc' } },
      take: 5,
    }),
    prisma.callTurn.groupBy({
      by: ['sentiment'],
      where: {
        createdAt: { gte: sevenDaysAgo },
        speaker: 'USER',
        sentiment: { not: null },
      },
      _count: { sentiment: true },
    }),
    prisma.$queryRaw<DailyRow[]>`
      SELECT
        date_trunc('day', created_at)::date AS day,
        COUNT(*)::bigint AS total,
        SUM(CASE WHEN outcome = 'CONVERTED' THEN 1 ELSE 0 END)::bigint AS converted
      FROM calls
      WHERE created_at >= ${sevenDaysAgo}
      GROUP BY day
      ORDER BY day ASC
    `,
    prisma.$queryRaw<HourRow[]>`
      SELECT
        EXTRACT(HOUR FROM created_at)::int AS hour,
        COUNT(*)::bigint AS n
      FROM calls
      WHERE created_at >= ${sevenDaysAgo}
      GROUP BY hour
      ORDER BY hour ASC
    `,
    prisma.call.aggregate({ _sum: { durationSeconds: true } }),
  ]);

  const outboundLast7d = last7d.filter((c) => !!c.productId).length;
  const inboundLast7d = last7d.length - outboundLast7d;

  const avgDurationTodaySec =
    durationRows.length > 0
      ? Math.round(
          durationRows.reduce((s, r) => s + (r.durationSeconds ?? 0), 0) /
            durationRows.length,
        )
      : 0;

  const productIds = products.map((p) => p.productId).filter((id): id is string => !!id);
  const productConversion =
    productIds.length > 0
      ? await prisma.call.groupBy({
          by: ['productId'],
          where: {
            createdAt: { gte: sevenDaysAgo },
            outcome: 'CONVERTED',
            productId: { in: productIds },
          },
          _count: { productId: true },
        })
      : [];
  const convByProduct = new Map(
    productConversion.map((r) => [r.productId, r._count.productId]),
  );

  const days: Array<{ day: string; total: number; converted: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const match = dailyRowsRaw.find(
      (r) => new Date(r.day).toISOString().slice(0, 10) === key,
    );
    days.push({
      day: key,
      total: match ? Number(match.total) : 0,
      converted: match ? Number(match.converted) : 0,
    });
  }

  const hours: Array<{ hour: number; count: number }> = [];
  for (let h = 0; h < 24; h++) {
    const match = hourRowsRaw.find((r) => Number(r.hour) === h);
    hours.push({ hour: h, count: match ? Number(match.n) : 0 });
  }

  const sentimentMix7d = { positive: 0, neutral: 0, negative: 0 };
  for (const row of sentimentRows) {
    const n = row._count.sentiment;
    if (row.sentiment === 'POSITIVE') sentimentMix7d.positive = n;
    else if (row.sentiment === 'NEGATIVE') sentimentMix7d.negative = n;
    else if (row.sentiment === 'NEUTRAL') sentimentMix7d.neutral = n;
  }

  return {
    callsToday,
    callsAllTime,
    conversionToday: callsToday > 0 ? Math.round((convertedToday / callsToday) * 100) : 0,
    conversionAllTime:
      callsAllTime > 0 ? Math.round((convertedAllTime / callsAllTime) * 100) : 0,
    activeNow,
    outboundLast7d,
    inboundLast7d,
    avgDurationTodaySec,
    totalDurationAllTimeSec: totalDurationAgg._sum.durationSeconds ?? 0,
    topObjectionTypes: objections.map((o) => ({
      type: (o.objectionType ?? 'UNKNOWN') as string,
      count: o._count.objectionType,
    })),
    topProducts: products
      .filter((p) => p.productId)
      .map((p) => ({
        productId: p.productId as string,
        count: p._count.productId,
        converted: convByProduct.get(p.productId as string) ?? 0,
      })),
    topTools: tools
      .filter((t) => t.toolCalled)
      .map((t) => ({
        name: t.toolCalled as string,
        count: t._count.toolCalled,
      })),
    dailySeries: days,
    hourlyDensity: hours,
    sentimentMix7d,
  };
}

export interface CallListItem {
  callId: string;
  createdAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  outcome: string | null;
  productId: string | null;
  phoneNumber: string | null;
  customerName: string | null;
  /** Serena tracks discount as an integer percentage on the Call row.
   *  Surfaced like "5%" in the calls table; null when the agent never
   *  offered one. */
  discountGiven: number;
  turnCount: number;
}

export interface CallListFilters {
  outcome?: string;
  productId?: string;
  q?: string;
  take?: number;
  skip?: number;
}

export async function loadCallList(filters: CallListFilters = {}): Promise<CallListItem[]> {
  const rows = await prisma.call.findMany({
    where: {
      ...(filters.outcome ? { outcome: filters.outcome as never } : {}),
      ...(filters.productId ? { productId: filters.productId } : {}),
      ...(filters.q
        ? {
            OR: [
              { callId: { contains: filters.q, mode: 'insensitive' } },
              { phoneNumber: { contains: filters.q, mode: 'insensitive' } },
              {
                customer: {
                  OR: [
                    { name: { contains: filters.q, mode: 'insensitive' } },
                    { email: { contains: filters.q, mode: 'insensitive' } },
                  ],
                },
              },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: filters.take ?? 50,
    skip: filters.skip ?? 0,
    include: {
      customer: { select: { name: true } },
      _count: { select: { turns: true } },
    },
  });
  return rows.map((r) => ({
    callId: r.callId,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
    durationSeconds: r.durationSeconds,
    outcome: r.outcome,
    productId: r.productId,
    phoneNumber: r.phoneNumber,
    customerName: r.customer?.name ?? null,
    discountGiven: r.discountGiven,
    turnCount: r._count.turns,
  }));
}

export async function loadCallDetail(callId: string) {
  return prisma.call.findUnique({
    where: { callId },
    include: {
      customer: true,
      turns: { orderBy: { turnNumber: 'asc' } },
      insight: true,
    },
  });
}

export async function loadActiveCalls() {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  return prisma.call.findMany({
    where: { endedAt: null, createdAt: { gte: thirtyMinAgo } },
    orderBy: { createdAt: 'desc' },
    include: {
      customer: { select: { name: true } },
      _count: { select: { turns: true } },
    },
    take: 25,
  });
}

export async function loadProducts() {
  return prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
}

export async function loadOffers() {
  return prisma.offer.findMany({
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    include: {
      product: { select: { id: true, name: true } },
      bundleProduct: { select: { id: true, name: true } },
    },
  });
}

/** Live offers keyed by product id — used by the Talk page so the browser
 * test opener can quote a real discount the same way phone callers hear it. */
export async function loadActiveOffersByProduct(): Promise<
  Record<string, { discountPct: number; shortPitch: string }>
> {
  const now = new Date();
  const offers = await prisma.offer.findMany({
    where: { isActive: true },
  });
  const byProduct: Record<string, { discountPct: number; shortPitch: string }> = {};
  for (const o of offers) {
    if (o.validUntil && o.validUntil < now) continue;
    if (!byProduct[o.productId]) {
      byProduct[o.productId] = {
        discountPct: o.discountPercent,
        shortPitch: o.shortPitch,
      };
    }
  }
  return byProduct;
}

export async function loadCustomers() {
  return prisma.customer.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: {
      _count: { select: { calls: true, purchases: true } },
    },
  });
}
