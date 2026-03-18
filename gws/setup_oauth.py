#!/usr/bin/env python3
"""
OAuth setup script for NanoClaw Google Workspace integration.

Performs the OAuth2 authorization flow to obtain tokens with all required scopes.
Opens a browser for user authorization, handles the callback, and saves token.json.

Usage:
    python3 gws/setup_oauth.py                    # Full auth flow (browser)
    python3 gws/setup_oauth.py --refresh-only      # Just refresh existing token
    python3 gws/setup_oauth.py --check             # Check token status
    python3 gws/setup_oauth.py --test              # Test all APIs after auth

Tokens are stored at ~/.config/gws/ which container-runner.ts mounts into containers.
Requires credentials.json from Google Cloud Console (OAuth 2.0 Client ID, Desktop type).
"""
import json
import os
import stat
import sys

# Token storage: ~/.config/gws/ (mounted read-only into containers by container-runner.ts)
TOKEN_DIR = os.path.expanduser('~/.config/gws')
CREDENTIALS_PATH = os.path.join(TOKEN_DIR, 'credentials.json')
TOKEN_PATH = os.path.join(TOKEN_DIR, 'token.json')

# Minimal scopes — least privilege:
#   gmail.modify: read, send, trash, archive (no permanent delete)
#   calendar.readonly: read-only calendar access
#   drive.readonly: read-only file listing/search
#   keep.readonly: read-only notes (Phase 1)
SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/keep.readonly',
]


def check_dependencies():
    """Check that required packages are installed."""
    missing = []
    try:
        import google.auth  # noqa: F401
    except ImportError:
        missing.append('google-auth')
    try:
        import google_auth_oauthlib  # noqa: F401
    except ImportError:
        missing.append('google-auth-oauthlib')
    try:
        import googleapiclient  # noqa: F401
    except ImportError:
        missing.append('google-api-python-client')

    if missing:
        print(f"Missing packages: {', '.join(missing)}")
        print(f"Install with: pip install {' '.join(missing)}")
        sys.exit(1)


def secure_permissions():
    """Set restrictive file permissions on token directory and files."""
    os.makedirs(TOKEN_DIR, exist_ok=True)
    os.chmod(TOKEN_DIR, stat.S_IRWXU)  # 0700

    if os.path.exists(TOKEN_PATH):
        os.chmod(TOKEN_PATH, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    if os.path.exists(CREDENTIALS_PATH):
        os.chmod(CREDENTIALS_PATH, stat.S_IRUSR | stat.S_IWUSR)  # 0600


def check_token():
    """Check current token status and scopes."""
    if not os.path.exists(TOKEN_PATH):
        print("No token.json found. Run without --check to authorize.")
        return False

    from google.oauth2.credentials import Credentials
    creds = Credentials.from_authorized_user_file(TOKEN_PATH)

    print(f"Token file: {TOKEN_PATH}")
    print(f"Valid: {creds.valid}")
    print(f"Expired: {creds.expired}")
    print(f"Has refresh token: {bool(creds.refresh_token)}")
    print(f"Expiry: {creds.expiry}")

    if creds.scopes:
        print(f"Scopes ({len(creds.scopes)}):")
        for s in sorted(creds.scopes):
            marker = '+' if s in SCOPES else ' '
            print(f"  [{marker}] {s.split('/')[-1]}")

        missing_scopes = set(SCOPES) - set(creds.scopes)
        if missing_scopes:
            print(f"\nMissing scopes (re-auth needed):")
            for s in sorted(missing_scopes):
                print(f"  - {s.split('/')[-1]}")
            return False
        else:
            print("\nAll required scopes are present.")
    else:
        print("Scopes: (not recorded in token — re-auth recommended)")

    return creds.valid or bool(creds.refresh_token)


def refresh_token():
    """Refresh an existing token without browser flow."""
    if not os.path.exists(TOKEN_PATH):
        print("No token.json found. Run full auth flow first.")
        sys.exit(1)

    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    creds = Credentials.from_authorized_user_file(TOKEN_PATH)
    if not creds.refresh_token:
        print("No refresh token available. Run full auth flow.")
        sys.exit(1)

    print("Refreshing token...")
    try:
        creds.refresh(Request())
    except Exception:
        print("Token refresh failed. Run full auth flow to re-authorize.")
        sys.exit(1)

    with open(TOKEN_PATH, 'w') as f:
        f.write(creds.to_json())
    secure_permissions()

    print(f"Token refreshed. New expiry: {creds.expiry}")
    print(f"Saved to: {TOKEN_PATH}")


def authorize():
    """Run full OAuth2 authorization flow with browser."""
    if not os.path.exists(CREDENTIALS_PATH):
        print(f"credentials.json not found at: {CREDENTIALS_PATH}")
        print("Download it from Google Cloud Console:")
        print("  1. Go to console.cloud.google.com")
        print("  2. APIs & Services > Credentials")
        print("  3. Create/download OAuth 2.0 Client ID (Desktop app type)")
        print(f"  4. Save as: {CREDENTIALS_PATH}")
        sys.exit(1)

    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None

    # Check if existing token just needs refresh (not scope expansion)
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH)
        if creds and creds.expired and creds.refresh_token:
            print("Token expired, attempting refresh first...")
            try:
                creds.refresh(Request())
                if creds.scopes and set(SCOPES).issubset(set(creds.scopes)):
                    with open(TOKEN_PATH, 'w') as f:
                        f.write(creds.to_json())
                    secure_permissions()
                    print(f"Token refreshed successfully. Expiry: {creds.expiry}")
                    return
                else:
                    print("Token refreshed but missing scopes. Starting full auth flow...")
            except Exception:
                print("Refresh failed. Starting full auth flow...")
        elif creds and creds.valid:
            if creds.scopes and set(SCOPES).issubset(set(creds.scopes)):
                print("Token is valid and has all required scopes. Nothing to do.")
                return

    # Full OAuth flow
    print(f"\nStarting OAuth flow with {len(SCOPES)} scopes:")
    for scope in SCOPES:
        print(f"  - {scope.split('/')[-1]}")
    print()

    flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
    creds = flow.run_local_server(port=0, prompt='consent', access_type='offline')

    # Validate granted scopes
    granted = set(creds.scopes) if creds.scopes else set()
    requested = set(SCOPES)
    if granted and not requested.issubset(granted):
        missing = requested - granted
        print(f"\nWARNING: Not all scopes were granted!")
        print(f"Missing: {[s.split('/')[-1] for s in missing]}")
        print("Some features will not work. Re-run to try again.")

    os.makedirs(TOKEN_DIR, exist_ok=True)
    with open(TOKEN_PATH, 'w') as f:
        f.write(creds.to_json())
    secure_permissions()

    print(f"\nAuthorization successful!")
    print(f"Token saved to: {TOKEN_PATH}")
    print(f"Expiry: {creds.expiry}")
    if creds.scopes:
        print(f"Scopes granted ({len(creds.scopes)}):")
        for s in sorted(creds.scopes):
            print(f"  - {s.split('/')[-1]}")


def test_apis():
    """Test all 4 APIs to verify the token works."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    if not os.path.exists(TOKEN_PATH):
        print("No token — cannot test.")
        return False

    creds = Credentials.from_authorized_user_file(TOKEN_PATH)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(TOKEN_PATH, 'w') as f:
            f.write(creds.to_json())
        secure_permissions()

    from googleapiclient.discovery import build

    all_passed = True

    # Test Gmail
    print("\n--- Gmail ---")
    try:
        service = build('gmail', 'v1', credentials=creds)
        results = service.users().messages().list(userId='me', q='in:inbox', maxResults=1).execute()
        total = results.get('resultSizeEstimate', 0)
        print(f"  OK: inbox has ~{total} messages")
    except Exception as e:
        print(f"  FAIL: {e}")
        all_passed = False

    # Test Calendar
    print("\n--- Calendar ---")
    try:
        from datetime import datetime, timedelta, timezone
        service = build('calendar', 'v3', credentials=creds)
        now = datetime.now(timezone.utc)
        events = service.events().list(
            calendarId='primary',
            timeMin=now.isoformat(),
            timeMax=(now + timedelta(days=7)).isoformat(),
            maxResults=5, singleEvents=True, orderBy='startTime',
        ).execute()
        items = events.get('items', [])
        print(f"  OK: {len(items)} events in next 7 days")
        for ev in items[:3]:
            start = ev['start'].get('dateTime', ev['start'].get('date'))
            print(f"    - {start}: {ev.get('summary', '(no title)')}")
    except Exception as e:
        print(f"  FAIL: {e}")
        all_passed = False

    # Test Drive
    print("\n--- Drive ---")
    try:
        service = build('drive', 'v3', credentials=creds)
        results = service.files().list(
            pageSize=3,
            fields='files(id, name, mimeType, modifiedTime)',
        ).execute()
        files = results.get('files', [])
        print(f"  OK: found {len(files)} recent files")
        for f in files[:3]:
            print(f"    - {f.get('name')} ({f.get('mimeType', '?').split('.')[-1]})")
    except Exception as e:
        print(f"  FAIL: {e}")
        all_passed = False

    # Test Keep
    print("\n--- Keep ---")
    try:
        service = build('keep', 'v1', credentials=creds)
        results = service.notes().list(pageSize=5).execute()
        notes = results.get('notes', [])
        print(f"  OK: found {len(notes)} notes")
        for note in notes[:3]:
            print(f"    - {note.get('title', '(untitled)')}")
    except Exception as e:
        print(f"  FAIL: {e}")
        all_passed = False

    if all_passed:
        print("\nAll API tests passed!")
    else:
        print("\nSome tests failed. Check the errors above.")

    return all_passed


def main():
    import argparse
    parser = argparse.ArgumentParser(description='NanoClaw Google Workspace OAuth Setup')
    parser.add_argument('--check', action='store_true', help='Check current token status')
    parser.add_argument('--refresh-only', action='store_true', help='Only refresh existing token')
    parser.add_argument('--test', action='store_true', help='Test all APIs after auth')
    args = parser.parse_args()

    check_dependencies()

    if args.check:
        check_token()
        return

    if args.refresh_only:
        refresh_token()
        if args.test:
            test_apis()
        return

    authorize()
    if args.test:
        test_apis()


if __name__ == '__main__':
    main()
