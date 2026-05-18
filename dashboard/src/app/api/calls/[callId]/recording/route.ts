import { NextResponse, type NextRequest } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { getCallRecording } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { callId } = await params;
  const result = await getCallRecording(callId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? 'recording lookup failed' },
      { status: result.status ?? 502 },
    );
  }
  return NextResponse.json({
    recording_url: result.recordingUrl ?? null,
    stereo_recording_url: result.stereoRecordingUrl ?? null,
  });
}
