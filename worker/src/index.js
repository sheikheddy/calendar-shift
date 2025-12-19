/**
 * Oura Webhook Worker
 *
 * Receives webhook notifications from Oura when new sleep data is available,
 * then shifts Google Calendar events based on actual wake time.
 */

// Sleep event names to identify wake time events
const SLEEP_EVENT_NAMES = ['sleep', 'wake', 'wakeup', 'wake up', 'bedtime'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        timestamp: new Date().toISOString()
      });
    }

    // Webhook endpoint
    if (url.pathname === '/webhook/oura') {
      if (request.method === 'GET') {
        return handleVerification(request, env);
      }
      if (request.method === 'POST') {
        return handleWebhook(request, env, ctx);
      }
    }

    // Manual trigger for testing
    if (url.pathname === '/trigger' && request.method === 'POST') {
      ctx.waitUntil(processCalendarShift(env));
      return Response.json({ status: 'triggered' });
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * Handle Oura webhook verification challenge
 */
function handleVerification(request, env) {
  const url = new URL(request.url);
  const challenge = url.searchParams.get('challenge');

  if (challenge) {
    console.log(`Verification challenge: ${challenge}`);
    return Response.json({ challenge });
  }

  return Response.json({ status: 'ready' });
}

/**
 * Handle incoming webhook notification
 */
async function handleWebhook(request, env, ctx) {
  try {
    const data = await request.json();
    console.log('Webhook received:', JSON.stringify(data));

    const eventType = data.event_type;
    const dataType = data.data_type;

    // Only process sleep create events
    if (dataType === 'sleep' && eventType === 'create') {
      console.log('New sleep data detected! Processing calendar shift...');
      // Process in background so we can respond quickly
      ctx.waitUntil(processCalendarShift(env));
      return Response.json({ status: 'processing' });
    }

    return Response.json({
      status: 'ignored',
      reason: 'not sleep create event'
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Main calendar shift logic
 */
async function processCalendarShift(env) {
  try {
    console.log('Starting calendar shift process...');

    // Get Oura wake time
    const actualWake = await getOuraWakeTime(env);
    if (!actualWake) {
      console.log('Could not get wake time from Oura');
      return;
    }
    console.log(`Actual wake time: ${actualWake.toISOString()}`);

    // Get Google Calendar service
    const accessToken = await getGoogleAccessToken(env);
    if (!accessToken) {
      console.log('Could not get Google access token');
      return;
    }

    // Get today's events
    const events = await getTodaysEvents(accessToken);
    console.log(`Found ${events.length} events today`);

    // Find expected wake time from Sleep event
    const expectedWake = getExpectedWakeTime(events);
    if (!expectedWake) {
      console.log('No Sleep event found to determine expected wake time');
      return;
    }
    console.log(`Expected wake time: ${expectedWake.toISOString()}`);

    // Calculate offset
    const offsetMs = actualWake.getTime() - expectedWake.getTime();
    const offsetMinutes = Math.round(offsetMs / 60000);
    console.log(`Offset: ${offsetMinutes} minutes`);

    if (offsetMinutes <= 0) {
      console.log('Woke up on time or early - no shifting needed');
      return;
    }

    // Get calendar ID for checking attendees
    const calendarInfo = await getCalendarInfo(accessToken);
    const myEmail = calendarInfo.id;

    // Shift eligible events
    let shifted = 0;
    let skipped = 0;

    for (const event of events) {
      const summary = event.summary || 'Untitled';

      // Skip sleep events
      if (SLEEP_EVENT_NAMES.some(name => summary.toLowerCase().includes(name))) {
        console.log(`SKIP (sleep event): ${summary}`);
        skipped++;
        continue;
      }

      // Skip all-day events
      if (event.start?.date) {
        console.log(`SKIP (all-day): ${summary}`);
        skipped++;
        continue;
      }

      // Skip events with other attendees
      if (!isSoloEvent(event, myEmail)) {
        console.log(`SKIP (has attendees): ${summary}`);
        skipped++;
        continue;
      }

      // Shift the event
      if (event.start?.dateTime) {
        await shiftEvent(accessToken, event, offsetMinutes);
        console.log(`SHIFTED: ${summary}`);
        shifted++;
      }
    }

    console.log(`Done! Shifted: ${shifted}, Skipped: ${skipped}`);

  } catch (error) {
    console.error('Calendar shift error:', error);
  }
}

/**
 * Get wake time from Oura API
 */
async function getOuraWakeTime(env) {
  const accessToken = await getOuraAccessToken(env);
  if (!accessToken) return null;

  const today = new Date();
  const threeDaysAgo = new Date(today);
  threeDaysAgo.setDate(today.getDate() - 3);

  const params = new URLSearchParams({
    start_date: threeDaysAgo.toISOString().split('T')[0],
    end_date: today.toISOString().split('T')[0]
  });

  const response = await fetch(
    `https://api.ouraring.com/v2/usercollection/sleep?${params}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  if (!response.ok) {
    console.error('Oura API error:', await response.text());
    return null;
  }

  const data = await response.json();
  const sessions = data.data || [];

  if (sessions.length === 0) {
    console.log('No sleep sessions found');
    return null;
  }

  // Find sessions that ended today
  const todayStr = today.toISOString().split('T')[0];
  const todaySessions = sessions.filter(s =>
    s.bedtime_end?.startsWith(todayStr)
  );

  const latestSession = todaySessions.length > 0
    ? todaySessions.reduce((a, b) =>
        a.bedtime_end > b.bedtime_end ? a : b)
    : sessions.reduce((a, b) =>
        a.bedtime_end > b.bedtime_end ? a : b);

  if (latestSession.bedtime_end) {
    return new Date(latestSession.bedtime_end);
  }

  return null;
}

/**
 * Get Oura access token, refreshing if needed
 */
async function getOuraAccessToken(env) {
  const tokenData = await env.TOKENS.get('oura_token', 'json');
  if (!tokenData) {
    console.log('No Oura token in KV');
    return null;
  }

  // Check if expired
  if (tokenData.expires_at && Date.now() / 1000 > tokenData.expires_at) {
    console.log('Oura token expired, refreshing...');
    return await refreshOuraToken(env, tokenData);
  }

  return tokenData.access_token;
}

/**
 * Refresh Oura OAuth token
 */
async function refreshOuraToken(env, tokenData) {
  const response = await fetch('https://api.ouraring.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
      client_id: env.OURA_CLIENT_ID,
      client_secret: env.OURA_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    console.error('Failed to refresh Oura token:', await response.text());
    return null;
  }

  const newToken = await response.json();
  if (!newToken.refresh_token) {
    newToken.refresh_token = tokenData.refresh_token;
  }
  if (newToken.expires_in) {
    newToken.expires_at = Date.now() / 1000 + newToken.expires_in;
  }

  await env.TOKENS.put('oura_token', JSON.stringify(newToken));
  return newToken.access_token;
}

/**
 * Get Google access token, refreshing if needed
 */
async function getGoogleAccessToken(env) {
  const tokenData = await env.TOKENS.get('google_token', 'json');
  if (!tokenData) {
    console.log('No Google token in KV');
    return null;
  }

  // Check if expired (with 5 min buffer)
  if (tokenData.expiry_date && Date.now() > tokenData.expiry_date - 300000) {
    console.log('Google token expired, refreshing...');
    return await refreshGoogleToken(env, tokenData);
  }

  return tokenData.access_token;
}

/**
 * Refresh Google OAuth token
 */
async function refreshGoogleToken(env, tokenData) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenData.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET
    })
  });

  if (!response.ok) {
    console.error('Failed to refresh Google token:', await response.text());
    return null;
  }

  const newToken = await response.json();
  const updated = {
    ...tokenData,
    access_token: newToken.access_token,
    expiry_date: Date.now() + (newToken.expires_in * 1000)
  };

  await env.TOKENS.put('google_token', JSON.stringify(updated));
  return updated.access_token;
}

/**
 * Get calendar info (to get user email)
 */
async function getCalendarInfo(accessToken) {
  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary',
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );
  return response.json();
}

/**
 * Get today's events from Google Calendar
 */
async function getTodaysEvents(accessToken) {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime'
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  const data = await response.json();
  return data.items || [];
}

/**
 * Get expected wake time from Sleep event
 */
function getExpectedWakeTime(events) {
  for (const event of events) {
    const summary = (event.summary || '').toLowerCase();
    if (SLEEP_EVENT_NAMES.some(name => summary.includes(name))) {
      if (event.end?.dateTime) {
        return new Date(event.end.dateTime);
      }
    }
  }
  return null;
}

/**
 * Check if event is solo (no other attendees)
 */
function isSoloEvent(event, myEmail) {
  const attendees = event.attendees || [];
  if (attendees.length === 0) return true;

  const others = attendees.filter(a =>
    a.email !== myEmail && !a.self
  );
  return others.length === 0;
}

/**
 * Shift an event by given minutes
 */
async function shiftEvent(accessToken, event, offsetMinutes) {
  const startDt = new Date(event.start.dateTime);
  const endDt = new Date(event.end.dateTime);

  startDt.setMinutes(startDt.getMinutes() + offsetMinutes);
  endDt.setMinutes(endDt.getMinutes() + offsetMinutes);

  const updatedEvent = {
    ...event,
    start: { ...event.start, dateTime: startDt.toISOString() },
    end: { ...event.end, dateTime: endDt.toISOString() }
  };

  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${event.id}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updatedEvent)
    }
  );
}
