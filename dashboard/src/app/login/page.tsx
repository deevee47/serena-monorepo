import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  next?: string;
}

// Deterministic, pre-baked spectrum so the SSR/CSR markup matches and the
// composition reads the same on every load. Tall in the middle, falling off
// at the edges — like a single sustained word frozen mid-utterance.
const BAR_COUNT = 96;
const BARS = Array.from({ length: BAR_COUNT }, (_, i) => {
  const t = (i / (BAR_COUNT - 1)) * 2 - 1; // -1 → 1
  const envelope = Math.exp(-1.8 * t * t); // gaussian falloff
  const wave =
    Math.sin(i * 0.42) * 0.55 +
    Math.sin(i * 0.21 + 1.3) * 0.3 +
    Math.sin(i * 0.93 + 0.6) * 0.15;
  return Math.max(1.5, Math.abs(wave) * 36 * envelope + 2);
});

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  return (
    <main className="login-shell relative isolate flex min-h-svh items-center justify-center overflow-hidden bg-background p-6">
      {/* Background composition — three quiet layers */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        {/* Layer 1 · warm spotlight behind the card */}
        <div className="login-spotlight absolute inset-0" />

        {/* Layer 2 · barely-there audio spectrum, horizon-aligned */}
        <svg
          className="login-wave absolute left-1/2 top-1/2 h-[44vh] w-[140vw] max-w-[1600px] -translate-x-1/2 -translate-y-1/2"
          viewBox={`0 0 ${BAR_COUNT * 10} 100`}
          preserveAspectRatio="none"
        >
          <defs>
            {/* Soft horizontal fade — edges dissolve into the page */}
            <linearGradient id="waveFade" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="black" stopOpacity="0" />
              <stop offset="18%" stopColor="black" stopOpacity="1" />
              <stop offset="82%" stopColor="black" stopOpacity="1" />
              <stop offset="100%" stopColor="black" stopOpacity="0" />
            </linearGradient>
            <mask id="waveMask">
              <rect width="100%" height="100%" fill="url(#waveFade)" />
            </mask>
            {/* The playhead sweep — a thin warm halo that drifts across */}
            <linearGradient id="playhead" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="var(--ff-orange)" stopOpacity="0" />
              <stop offset="50%" stopColor="var(--ff-orange)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--ff-orange)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Static horizon hairline */}
          <line
            x1="0"
            x2={BAR_COUNT * 10}
            y1="50"
            y2="50"
            className="login-horizon"
            mask="url(#waveMask)"
          />

          {/* The bars themselves */}
          <g className="login-bars" mask="url(#waveMask)">
            {BARS.map((h, i) => (
              <rect
                key={i}
                x={i * 10 + 4}
                y={50 - h / 2}
                width="2"
                height={h}
                style={{ animationDelay: `${(i % 12) * 120}ms` }}
              />
            ))}
          </g>

          {/* Slow drifting playhead */}
          <rect
            className="login-playhead"
            x="-220"
            y="0"
            width="220"
            height="100"
            fill="url(#playhead)"
            mask="url(#waveMask)"
          />
        </svg>

        {/* Layer 3 · film grain — keeps the dark from looking digital */}
        <svg className="login-grain absolute inset-0 h-full w-full opacity-[0.035]">
          <filter id="grainFilter">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#grainFilter)" />
        </svg>

        {/* Layer 4 · vignette to seat the card */}
        <div className="login-vignette absolute inset-0" />
      </div>

      {/* The panel */}
      <div className="relative w-full max-w-sm">
        {/* 1px FF-orange accent rail at the top of the card */}
        <span aria-hidden className="login-rail absolute -top-px left-0 right-0 h-px" />

        <Card className="login-card relative w-full overflow-hidden border-border/80 bg-card/85 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.45)] backdrop-blur-md">
          <CardHeader className="space-y-3">
            <div className="flex items-center gap-2.5">
              <span className="relative flex size-2 items-center justify-center">
                <span className="login-pulse absolute inset-0 bg-ff-orange/60" />
                <span className="relative size-2 bg-ff-orange" />
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                Live · Secure channel
              </span>
            </div>
            <CardTitle className="text-2xl font-light uppercase tracking-[0.28em]">
              Serena
            </CardTitle>
            <CardDescription>
              Sign in to view calls and trigger outbound dials.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/api/auth" method="post" className="space-y-5">
              <input type="hidden" name="next" value={sp.next ?? '/'} />
              <div className="space-y-2">
                <Label
                  htmlFor="password"
                  className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
                >
                  Password
                </Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  placeholder="Shared dashboard password"
                  required
                  autoFocus
                  className="h-11 bg-background/60"
                />
              </div>
              {sp.error ? (
                <p className="text-sm text-destructive">Incorrect password — try again.</p>
              ) : null}
              <Button type="submit" className="h-11 w-full text-sm font-medium tracking-wide">
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Tiny footer signature — feels like a status bar from a console */}
        <div className="mt-6 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">
          <span>FF · Voice Ops</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-1 bg-muted-foreground/60" />
            v1.0
          </span>
        </div>
      </div>
    </main>
  );
}
