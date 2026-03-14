import { NextResponse } from 'next/server';
import { generateSpeech, type VoiceContext } from '@/lib/elevenlabs';
import { getDb } from '@/lib/mongodb';

export async function POST(request: Request) {
  try {
    const { text, context, query } = await request.json();

    // If this is a voice query, generate a contextual response first
    if (query) {
      const responseText = await handleVoiceQuery(query);
      const result = await generateSpeech(responseText, 'summary');

      return NextResponse.json({
        text: responseText,
        audio_base64: result?.audio_base64 || null,
      });
    }

    // Direct TTS — just speak the given text
    if (!text) {
      return NextResponse.json({ error: 'text or query is required' }, { status: 400 });
    }

    const result = await generateSpeech(text, (context as VoiceContext) || 'detection');

    if (!result) {
      return NextResponse.json({ error: 'Speech generation failed' }, { status: 500 });
    }

    return NextResponse.json({ text, ...result });
  } catch (error) {
    console.error('Speak error:', error);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

/**
 * Query MongoDB for recent detections, then use Gemini to generate
 * a natural language answer to the user's question.
 */
async function handleVoiceQuery(query: string): Promise<string> {
  const db = await getDb();
  const since = new Date(Date.now() - 15 * 60 * 1000);

  // Get recent detection stats
  const recentDetections = await db
    .collection('detections')
    .find({ timestamp: { $gte: since } })
    .sort({ timestamp: -1 })
    .limit(20)
    .toArray();

  const recentEvents = await db
    .collection('events')
    .find({ timestamp: { $gte: since } })
    .sort({ timestamp: -1 })
    .limit(10)
    .toArray();

  const totalPeople = recentDetections.reduce(
    (sum, d) => sum + (d.vision?.people?.length || 0),
    0
  );
  const avgPeople = recentDetections.length > 0 ? (totalPeople / recentDetections.length).toFixed(1) : '0';
  const maxPeople = Math.max(0, ...recentDetections.map(d => d.vision?.people?.length || 0));
  const alerts = recentEvents.filter(e => e.severity === 'alert').length;

  const summaryContext = `Recent 15 minutes: ${recentDetections.length} perception cycles, avg ${avgPeople} people/frame, peak ${maxPeople} people, ${alerts} alerts. Recent events: ${recentEvents.map(e => `[${e.event_type}: ${e.description}]`).join(', ') || 'none'}.`;

  // Use Gemini to generate a natural response
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return `In the last 15 minutes, I recorded ${recentDetections.length} observations with an average of ${avgPeople} people per frame and ${alerts} alerts.`;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are SENTINEL, an autonomous perception station. A user asked you a question. Answer concisely in 1-3 sentences based on your observation data. Speak in first person as SENTINEL.

USER QUESTION: "${query}"

YOUR OBSERVATION DATA:
${summaryContext}

Respond with ONLY the spoken answer (no JSON, no markdown).`,
            }],
          }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 200 },
        }),
      }
    );

    const data = await response.json();
    return data.candidates[0].content.parts[0].text.trim();
  } catch {
    return `In the last 15 minutes, I recorded ${recentDetections.length} observations with an average of ${avgPeople} people per frame and ${alerts} alerts.`;
  }
}
