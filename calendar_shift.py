#!/usr/bin/env python3
"""
Calendar Shift Tool

Shifts personal calendar events by N hours when waking up late.
Uses Oura Ring API to detect actual wake time.
Skips events with other attendees (meetings).

Usage:
    python calendar_shift.py                    # Auto-detect wake time from Oura
    python calendar_shift.py --offset 120       # Manual offset in minutes
    python calendar_shift.py --dry-run          # Preview without changes
"""

import argparse
import json
import os
import webbrowser
from datetime import datetime, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional
from urllib.parse import urlencode, urlparse, parse_qs

import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# Google Calendar scopes
SCOPES = ['https://www.googleapis.com/auth/calendar']

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_FILE = os.path.join(SCRIPT_DIR, 'credentials.json')
TOKEN_FILE = os.path.join(SCRIPT_DIR, 'token.json')
OURA_CREDENTIALS_FILE = os.path.join(SCRIPT_DIR, 'oura_credentials.json')
OURA_TOKEN_FILE = os.path.join(SCRIPT_DIR, 'oura_token.json')

# Event names that indicate sleep/wake time
SLEEP_EVENT_NAMES = ['sleep', 'wake', 'wakeup', 'wake up', 'bedtime']

# Oura OAuth2 URLs
OURA_AUTH_URL = 'https://cloud.ouraring.com/oauth/authorize'
OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token'
OURA_API_BASE = 'https://api.ouraring.com/v2/usercollection'
OURA_REDIRECT_URI = 'http://localhost:8080/callback'


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    """Handle OAuth callback from Oura."""

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/callback':
            query = parse_qs(parsed.query)
            if 'code' in query:
                self.server.auth_code = query['code'][0]
                self.send_response(200)
                self.send_header('Content-type', 'text/html')
                self.end_headers()
                self.wfile.write(b'<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>')
            else:
                self.server.auth_code = None
                self.send_response(400)
                self.send_header('Content-type', 'text/html')
                self.end_headers()
                self.wfile.write(b'<html><body><h1>Authorization failed</h1></body></html>')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Suppress logging


def load_oura_credentials():
    """Load Oura OAuth credentials from file."""
    if not os.path.exists(OURA_CREDENTIALS_FILE):
        return None
    with open(OURA_CREDENTIALS_FILE, 'r') as f:
        return json.load(f)


def save_oura_token(token_data):
    """Save Oura OAuth token to file."""
    with open(OURA_TOKEN_FILE, 'w') as f:
        json.dump(token_data, f)


def load_oura_token():
    """Load Oura OAuth token from file."""
    if not os.path.exists(OURA_TOKEN_FILE):
        return None
    with open(OURA_TOKEN_FILE, 'r') as f:
        return json.load(f)


def refresh_oura_token(credentials, token_data):
    """Refresh Oura OAuth token."""
    response = requests.post(OURA_TOKEN_URL, data={
        'grant_type': 'refresh_token',
        'refresh_token': token_data['refresh_token'],
        'client_id': credentials['client_id'],
        'client_secret': credentials['client_secret'],
    })

    if response.status_code == 200:
        new_token = response.json()
        # Preserve refresh token if not returned
        if 'refresh_token' not in new_token:
            new_token['refresh_token'] = token_data['refresh_token']
        save_oura_token(new_token)
        return new_token
    return None


def get_oura_token():
    """Get valid Oura OAuth token, refreshing or authorizing as needed."""
    credentials = load_oura_credentials()
    if not credentials:
        print(f"Error: {OURA_CREDENTIALS_FILE} not found.")
        print("Please create it with your Oura client_id and client_secret.")
        return None

    token_data = load_oura_token()

    # If we have a token, try to use it or refresh it
    if token_data:
        # Check if token is expired (Oura tokens last 24 hours)
        if 'expires_at' in token_data:
            if datetime.now().timestamp() < token_data['expires_at']:
                return token_data['access_token']

        # Try to refresh
        new_token = refresh_oura_token(credentials, token_data)
        if new_token:
            return new_token['access_token']

    # Need to authorize
    print("Oura authorization required. Opening browser...")

    auth_params = {
        'response_type': 'code',
        'client_id': credentials['client_id'],
        'redirect_uri': OURA_REDIRECT_URI,
        'scope': 'daily sleep personal',
    }

    auth_url = f"{OURA_AUTH_URL}?{urlencode(auth_params)}"

    # Start local server to receive callback
    server = HTTPServer(('localhost', 8080), OAuthCallbackHandler)
    server.auth_code = None

    webbrowser.open(auth_url)
    print(f"If browser doesn't open, go to:\n{auth_url}")

    # Wait for callback
    while server.auth_code is None:
        server.handle_request()

    auth_code = server.auth_code

    # Exchange code for token
    response = requests.post(OURA_TOKEN_URL, data={
        'grant_type': 'authorization_code',
        'code': auth_code,
        'redirect_uri': OURA_REDIRECT_URI,
        'client_id': credentials['client_id'],
        'client_secret': credentials['client_secret'],
    })

    if response.status_code != 200:
        print(f"Error getting token: {response.text}")
        return None

    token_data = response.json()
    # Add expiration timestamp
    if 'expires_in' in token_data:
        token_data['expires_at'] = datetime.now().timestamp() + token_data['expires_in']

    save_oura_token(token_data)
    print("Oura authorization successful!")

    return token_data['access_token']


def get_oura_wake_time() -> Optional[datetime]:
    """Get wake time from Oura Ring API (bedtime_end of last night's sleep)."""
    token = get_oura_token()
    if not token:
        return None

    today = datetime.now().date()
    # Query a wider range to catch sleep that spans midnight
    three_days_ago = today - timedelta(days=3)

    headers = {'Authorization': f'Bearer {token}'}
    params = {
        'start_date': three_days_ago.isoformat(),
        'end_date': today.isoformat()
    }

    try:
        response = requests.get(
            f'{OURA_API_BASE}/sleep',
            headers=headers,
            params=params
        )
        response.raise_for_status()
        data = response.json()

        sleep_sessions = data.get('data', [])
        if not sleep_sessions:
            print("No sleep data found in Oura.")
            return None

        # Find sleep sessions that ended today (morning wake up)
        today_sessions = []
        for session in sleep_sessions:
            bedtime_end = session.get('bedtime_end', '')
            if bedtime_end:
                end_dt = datetime.fromisoformat(bedtime_end.replace('Z', '+00:00'))
                # Check if this sleep ended today
                if end_dt.date() == today:
                    today_sessions.append(session)

        if today_sessions:
            # Get the one with latest bedtime_end (most recent wake)
            latest_sleep = max(today_sessions, key=lambda x: x.get('bedtime_end', ''))
        else:
            # Fallback to most recent overall
            print("No sleep ending today found, using most recent session.")
            latest_sleep = max(sleep_sessions, key=lambda x: x.get('bedtime_end', ''))

        bedtime_end = latest_sleep.get('bedtime_end')
        print(f"  Sleep session: {latest_sleep.get('bedtime_start', 'N/A')} to {bedtime_end}")

        if bedtime_end:
            return datetime.fromisoformat(bedtime_end.replace('Z', '+00:00'))

    except requests.RequestException as e:
        print(f"Error fetching Oura data: {e}")

    return None


def get_calendar_service():
    """Authenticate and return Google Calendar service."""
    creds = None

    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_FILE):
                print(f"Error: {CREDENTIALS_FILE} not found.")
                print("Please download OAuth credentials from Google Cloud Console.")
                exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(TOKEN_FILE, 'w') as token:
            token.write(creds.to_json())

    return build('calendar', 'v3', credentials=creds)


def get_todays_events(service, calendar_id='primary'):
    """Fetch all events for today."""
    now = datetime.now()
    start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end_of_day = start_of_day + timedelta(days=1)

    events_result = service.events().list(
        calendarId=calendar_id,
        timeMin=start_of_day.isoformat() + 'Z',
        timeMax=end_of_day.isoformat() + 'Z',
        singleEvents=True,
        orderBy='startTime'
    ).execute()

    return events_result.get('items', [])


def find_sleep_event(events) -> Optional[dict]:
    """Find the sleep/wake event to determine expected wake time."""
    for event in events:
        summary = event.get('summary', '').lower()
        if any(name in summary for name in SLEEP_EVENT_NAMES):
            return event
    return None


def get_expected_wake_time(events) -> Optional[datetime]:
    """Get expected wake time from Sleep event end time."""
    sleep_event = find_sleep_event(events)
    if not sleep_event:
        print("Warning: No 'Sleep' event found in calendar.")
        return None

    end_time_str = sleep_event.get('end', {}).get('dateTime')
    if not end_time_str:
        return None

    if end_time_str.endswith('Z'):
        return datetime.fromisoformat(end_time_str.replace('Z', '+00:00'))
    return datetime.fromisoformat(end_time_str)


def is_solo_event(event, my_email: str) -> bool:
    """Check if event is a solo event (no other attendees)."""
    attendees = event.get('attendees', [])

    if not attendees:
        return True

    other_attendees = [a for a in attendees if a.get('email') != my_email and not a.get('self')]
    return len(other_attendees) == 0


def shift_event(service, event, offset_minutes: int, calendar_id='primary'):
    """Shift an event by the given offset."""
    offset = timedelta(minutes=offset_minutes)

    start = event.get('start', {})
    end = event.get('end', {})

    if 'dateTime' in start:
        start_dt = datetime.fromisoformat(start['dateTime'].replace('Z', '+00:00'))
        end_dt = datetime.fromisoformat(end['dateTime'].replace('Z', '+00:00'))

        new_start = start_dt + offset
        new_end = end_dt + offset

        if start['dateTime'].endswith('Z'):
            event['start']['dateTime'] = new_start.strftime('%Y-%m-%dT%H:%M:%S') + 'Z'
            event['end']['dateTime'] = new_end.strftime('%Y-%m-%dT%H:%M:%S') + 'Z'
        else:
            event['start']['dateTime'] = new_start.isoformat()
            event['end']['dateTime'] = new_end.isoformat()

        service.events().update(
            calendarId=calendar_id,
            eventId=event['id'],
            body=event
        ).execute()

        return True
    return False


def main():
    parser = argparse.ArgumentParser(description='Shift calendar events when waking up late')
    parser.add_argument('--offset', type=int, help='Offset in minutes (overrides Oura detection)')
    parser.add_argument('--dry-run', action='store_true', help='Preview without making changes')
    parser.add_argument('--calendar', type=str, default='primary', help='Calendar ID to use')
    args = parser.parse_args()

    print("Authenticating with Google Calendar...")
    service = get_calendar_service()

    calendar = service.calendars().get(calendarId=args.calendar).execute()
    my_email = calendar.get('id', '')

    print("Fetching today's events...")
    events = get_todays_events(service, args.calendar)
    print(f"Found {len(events)} events")

    if args.offset:
        offset_minutes = args.offset
        print(f"Using manual offset: {offset_minutes} minutes")
    else:
        print("Fetching wake time from Oura Ring...")
        actual_wake = get_oura_wake_time()

        if not actual_wake:
            print("Error: Could not get wake time from Oura.")
            print("Use --offset to specify offset manually.")
            exit(1)

        expected_wake = get_expected_wake_time(events)

        if not expected_wake:
            print("Error: Could not determine expected wake time from Sleep event.")
            print("Use --offset to specify offset manually.")
            exit(1)

        actual_wake_naive = actual_wake.replace(tzinfo=None) if actual_wake.tzinfo else actual_wake
        expected_wake_naive = expected_wake.replace(tzinfo=None) if expected_wake.tzinfo else expected_wake

        offset_delta = actual_wake_naive - expected_wake_naive
        offset_minutes = int(offset_delta.total_seconds() / 60)

        print(f"Expected wake: {expected_wake_naive.strftime('%H:%M')}")
        print(f"Actual wake (Oura): {actual_wake_naive.strftime('%H:%M')}")

    print(f"Offset: {offset_minutes} minutes ({offset_minutes/60:.1f} hours)")

    if offset_minutes <= 0:
        print("You woke up on time or early! No shifting needed.")
        exit(0)

    shifted = 0
    skipped = 0

    for event in events:
        summary = event.get('summary', 'Untitled')

        if any(name in summary.lower() for name in SLEEP_EVENT_NAMES):
            print(f"  SKIP (sleep event): {summary}")
            skipped += 1
            continue

        if 'date' in event.get('start', {}):
            print(f"  SKIP (all-day): {summary}")
            skipped += 1
            continue

        if not is_solo_event(event, my_email):
            print(f"  SKIP (has attendees): {summary}")
            skipped += 1
            continue

        start_time = event.get('start', {}).get('dateTime', '')
        if start_time:
            start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
            new_start = start_dt + timedelta(minutes=offset_minutes)

            if args.dry_run:
                print(f"  WOULD SHIFT: {summary} ({start_dt.strftime('%H:%M')} -> {new_start.strftime('%H:%M')})")
            else:
                shift_event(service, event, offset_minutes, args.calendar)
                print(f"  SHIFTED: {summary} ({start_dt.strftime('%H:%M')} -> {new_start.strftime('%H:%M')})")
            shifted += 1

    print(f"\nDone! Shifted: {shifted}, Skipped: {skipped}")


if __name__ == '__main__':
    main()
