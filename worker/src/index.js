/**
 * Oura Webhook Worker
 *
 * Receives webhook notifications from Oura when new sleep data is available,
 * then shifts Google Calendar events based on actual wake time.
 */

// Sleep event names to identify wake time events
export const SLEEP_EVENT_NAMES = ['sleep', 'wake', 'wakeup', 'wake up', 'bedtime'];

// Prayer times - these are fixed based on sun position and should never shift
export const PRAYER_EVENT_NAMES = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha', 'prayer', 'salah', 'salat'];

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

    // Diagnostic endpoint - shows what would happen without making changes
    if (url.pathname === '/debug') {
      return await handleDebug(env);
    }

    // Google OAuth flow
    if (url.pathname === '/auth/google') {
      const redirectUri = `${url.origin}/auth/google/callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      return Response.redirect(authUrl.toString(), 302);
    }

    if (url.pathname === '/auth/google/callback') {
      const code = url.searchParams.get('code');
      if (!code) {
        return new Response('Missing code', { status: 400 });
      }

      const redirectUri = `${url.origin}/auth/google/callback`;
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });

      if (!response.ok) {
        const error = await response.text();
        return new Response(`Token exchange failed: ${error}`, { status: 500 });
      }

      const tokens = await response.json();
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: Date.now() + (tokens.expires_in * 1000)
      };

      await env.TOKENS.put('google_token', JSON.stringify(tokenData));
      return new Response('Google Calendar authorized! You can close this window.', {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * Debug endpoint to diagnose calendar shift issues
 */
async function handleDebug(env) {
  const debug = { timestamp: new Date().toISOString() };

  try {
    // Get Oura wake time
    const actualWake = await getOuraWakeTime(env);
    debug.oura = {
      wakeTime: actualWake ? actualWake.toISOString() : null,
      error: actualWake ? null : 'Could not get wake time'
    };

    // Get Google access token
    const accessToken = await getGoogleAccessToken(env);
    debug.google = {
      hasToken: !!accessToken,
      error: accessToken ? null : 'Could not get access token'
    };

    if (accessToken) {
      // Get calendar info for timezone
      const calendarInfo = await getCalendarInfo(accessToken);
      const timeZone = calendarInfo.timeZone || 'America/New_York';
      const myEmail = calendarInfo.id;
      debug.timeZone = timeZone;

      // Show query params for debugging
      const { startStr, endStr, localDate } = getDayBoundariesInTimezone(timeZone);
      debug.query = { timeMin: startStr, timeMax: endStr, localDate };

      // Get today's events - also capture raw response for debugging
      const eventsResponse = await getTodaysEventsRaw(accessToken, timeZone);
      debug.rawResponse = eventsResponse.raw;
      const events = eventsResponse.items;
      debug.events = {
        count: events.length,
        list: events.map(e => ({
          summary: e.summary || 'Untitled',
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date
        }))
      };

      // Find expected wake time
      const expectedWake = getExpectedWakeTime(events);
      debug.expectedWake = expectedWake ? expectedWake.toISOString() : null;

      if (actualWake && expectedWake) {
        const offsetMinutes = calculateOffset(actualWake, expectedWake);
        debug.offset = {
          minutes: offsetMinutes,
          wouldShift: offsetMinutes > 0
        };
        debug.wouldShift = [];
        debug.wouldSkip = [];

        for (const event of events) {
          const result = shouldSkipEvent(event, myEmail);
          if (result.skip) {
            debug.wouldSkip.push({ summary: event.summary, reason: result.reason });
          } else {
            debug.wouldShift.push({ summary: event.summary });
          }
        }
      }
    }
  } catch (error) {
    debug.error = error.message;
  }

  return Response.json(debug, { headers: { 'Content-Type': 'application/json' } });
}

/**
 * Handle Oura webhook verification challenge
 */
export function handleVerification(request, env) {
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
export async function handleWebhook(request, env, ctx) {
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

    // Get calendar info for timezone
    const calendarInfo = await getCalendarInfo(accessToken);
    const timeZone = calendarInfo.timeZone || 'America/New_York';
    const myEmail = calendarInfo.id;
    console.log(`Calendar timezone: ${timeZone}`);

    // Get today's events
    const events = await getTodaysEvents(accessToken, timeZone);
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

      // Skip prayer times (fixed based on sun position)
      if (PRAYER_EVENT_NAMES.some(name => summary.toLowerCase().includes(name))) {
        console.log(`SKIP (prayer time): ${summary}`);
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
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const params = new URLSearchParams({
    start_date: threeDaysAgo.toISOString().split('T')[0],
    end_date: tomorrow.toISOString().split('T')[0] // Oura API end_date is exclusive
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
 * Get calendar info (email and timezone)
 * @param {string} accessToken - Google OAuth access token
 * @returns {Promise<{id: string, timeZone: string, summary: string}>} Calendar metadata
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
 * Get start and end of day in a specific timezone
 * @param {string} timeZone - IANA timezone name (e.g., 'America/New_York')
 * @returns {{ startStr: string, endStr: string, localDate: string }} Day boundaries
 */
function getDayBoundariesInTimezone(timeZone) {
  const now = new Date();

  // Get today's date in the target timezone (YYYY-MM-DD format)
  const localDate = now.toLocaleDateString('en-CA', { timeZone });

  // Create proper RFC3339 timestamps by parsing local midnight and converting to ISO
  // This creates a date at midnight local time, then converts to UTC ISO string
  const startDate = new Date(`${localDate}T00:00:00`);
  const endDate = new Date(`${localDate}T23:59:59`);

  // Get timezone offset for the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    timeZoneName: 'shortOffset'
  });
  const parts = formatter.formatToParts(now);
  const offsetPart = parts.find(p => p.type === 'timeZoneName');
  // Convert "GMT-5" to "-05:00" format
  let offset = '+00:00';
  if (offsetPart) {
    const match = offsetPart.value.match(/GMT([+-]?)(\d+)?/);
    if (match) {
      const sign = match[1] || '+';
      const hours = match[2] ? match[2].padStart(2, '0') : '00';
      offset = `${sign}${hours}:00`;
    }
  }

  const startStr = `${localDate}T00:00:00${offset}`;
  const endStr = `${localDate}T23:59:59${offset}`;

  return { startStr, endStr, localDate };
}

/**
 * Get today's events from Google Calendar
 * @param {string} accessToken - Google OAuth access token
 * @param {string} [timeZone='America/New_York'] - IANA timezone name
 * @returns {Promise<Array<Object>>} Array of calendar events
 */
async function getTodaysEvents(accessToken, timeZone = 'America/New_York') {
  const result = await getTodaysEventsRaw(accessToken, timeZone);
  return result.items;
}

async function getTodaysEventsRaw(accessToken, timeZone = 'America/New_York') {
  const { startStr, endStr } = getDayBoundariesInTimezone(timeZone);

  const params = new URLSearchParams({
    timeMin: startStr,
    timeMax: endStr,
    timeZone: timeZone,
    singleEvents: 'true',
    orderBy: 'startTime'
  });

  console.log('Fetching events with params:', Object.fromEntries(params));

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  const data = await response.json();
  console.log('Calendar API response:', JSON.stringify(data).slice(0, 500));
  return {
    items: data.items || [],
    raw: {
      status: response.status,
      summary: data.summary,
      error: data.error,
      itemCount: data.items?.length
    }
  };
}

/**
 * Get expected wake time from Sleep event
 */
export function getExpectedWakeTime(events) {
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
export function isSoloEvent(event, myEmail) {
  const attendees = event.attendees || [];
  if (attendees.length === 0) return true;

  const others = attendees.filter(a =>
    a.email !== myEmail && !a.self
  );
  return others.length === 0;
}

/**
 * Determine if an event should be skipped from shifting
 * Returns { skip: boolean, reason: string | null }
 */
export function shouldSkipEvent(event, myEmail) {
  const summary = event.summary || 'Untitled';
  const lowerSummary = summary.toLowerCase();

  // Skip sleep events
  if (SLEEP_EVENT_NAMES.some(name => lowerSummary.includes(name))) {
    return { skip: true, reason: 'sleep event' };
  }

  // Skip prayer times (fixed based on sun position)
  if (PRAYER_EVENT_NAMES.some(name => lowerSummary.includes(name))) {
    return { skip: true, reason: 'prayer time' };
  }

  // Skip all-day events
  if (event.start?.date) {
    return { skip: true, reason: 'all-day event' };
  }

  // Skip events with other attendees
  if (!isSoloEvent(event, myEmail)) {
    return { skip: true, reason: 'has attendees' };
  }

  // Skip events without dateTime (shouldn't happen if not all-day, but safety check)
  if (!event.start?.dateTime) {
    return { skip: true, reason: 'no start time' };
  }

  return { skip: false, reason: null };
}

/**
 * Calculate shifted times for an event
 */
export function calculateShiftedTimes(event, offsetMinutes) {
  const startDt = new Date(event.start.dateTime);
  const endDt = new Date(event.end.dateTime);

  startDt.setMinutes(startDt.getMinutes() + offsetMinutes);
  endDt.setMinutes(endDt.getMinutes() + offsetMinutes);

  return {
    start: { ...event.start, dateTime: startDt.toISOString() },
    end: { ...event.end, dateTime: endDt.toISOString() }
  };
}

/**
 * Calculate offset in minutes between actual and expected wake time
 */
export function calculateOffset(actualWake, expectedWake) {
  const offsetMs = actualWake.getTime() - expectedWake.getTime();
  return Math.round(offsetMs / 60000);
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
