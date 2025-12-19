# Calendar Shift Tool

Automatically shifts your personal calendar events when you wake up late. Uses Oura Ring to detect actual wake time, compares to your scheduled "Sleep" event end time, and shifts all solo events by the difference.

## How It Works

```
Expected wake (from calendar): 7:00 AM
Actual wake (from Oura Ring): 9:00 AM
Offset: +2 hours

Events shifted:
- 7:15 AM "Breakfast" → 9:15 AM ✓
- 8:00 AM "Commute" → 10:00 AM ✓
- 10:00 AM "Team standup" (3 attendees) → SKIPPED
- 12:00 PM "Lunch" → 2:00 PM ✓
```

## Setup

### 1. Install Dependencies

```bash
pip install google-auth google-auth-oauthlib google-api-python-client requests
```

### 2. Google Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable the **Google Calendar API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Desktop app**
6. Download the JSON and save as `credentials.json` in this folder

### 3. Oura Ring API

1. Go to [Oura Personal Access Tokens](https://cloud.ouraring.com/personal-access-tokens)
2. Create a new token
3. Add it to `config.txt`:
   ```
   OURA_TOKEN=your_token_here
   ```

### 4. Calendar Setup

Make sure you have a **"Sleep"** event in your calendar that ends at your expected wake time. The script uses this to calculate how late you woke up.

## Usage

```bash
# Auto-detect wake time from Oura and shift events
python calendar_shift.py

# Preview what would be shifted (no changes)
python calendar_shift.py --dry-run

# Manual offset (in minutes)
python calendar_shift.py --offset 120

# Use a specific calendar
python calendar_shift.py --calendar "Work"
```

## Event Filtering

The script only shifts events that are:
- **Solo events** (no other attendees)
- **Timed events** (not all-day)
- **Not the Sleep event itself**

Events with other attendees (meetings) are never shifted.

## iOS Automation (Optional)

To run automatically when you wake up:

1. Open **Shortcuts** app on iPhone
2. Create new **Automation** → **When alarm is stopped**
3. Add action: **Run Script Over SSH**
   - Host: your Mac's IP
   - User: your username
   - Script: `python3 ~/projects/calendar-shift/calendar_shift.py`

Or use the Oura Ring's native wake detection (the script reads from Oura API automatically).

## Sources

- [Oura API Documentation](https://cloud.ouraring.com/v2/docs)
- [Google Calendar API](https://developers.google.com/calendar/api)
