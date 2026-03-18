#!/usr/bin/env python3
"""
OAuth setup script for NanoClaw Google Workspace integration.

Performs the OAuth2 authorization flow to obtain tokens with all required scopes.
Opens a browser for user authorization, handles the callback, and saves token.json.

Usage:
    python3 oauth_setup.py                    # Full auth flow (browser)
    python3 oauth_setup.py --refresh-only     # Just refresh existing token
    python3 oauth_setup.py --check            # Check token status

Requires credentials.json in the same directory (from Google Cloud Console).
"""
import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_DIR = os.path.join(SCRIPT_DIR, 'tokens')
CREDENTIALS_PATH = os.path.join(TOKEN_DIR, 'credentials.json')
TOKEN_PATH = os.path.join(TOKEN_DIR, 'token.json')

# Minimal scopes — least privilege:
#   gmail.modify: read, send, trash, archive (no permanent delete; subsumes gmail.send + gmail.readonly)
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
    print(f"Scopes: {creds.scopes or '(not recorded)'}")
    print(f"Expiry: {creds.expiry}")

    # Check which requested scopes are covered
    if creds.scopes:
        missing_scopes = set(SCOPES) - set(creds.scopes)
        if missing_scopes:
            print(f"\nMissing scopes (re-auth needed):")
            for s in sorted(missing_scopes):
                print(f"  - {s}")
            return False
        else:
            print("\nAll required scopes are present.")

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
    creds.refresh(Request())

    with open(TOKEN_PATH, 'w') as f:
        f.write(creds.to_json())

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

    # Check if we have an existing token that just needs scope expansion
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH)
        if creds and creds.valid:
            # Check if scopes are sufficient
            if creds.scopes and set(SCOPES).issubset(set(creds.scopes)):
                print("Token is valid and has all required scopes. Nothing to do.")
                return
        elif creds and creds.expired and creds.refresh_token:
            print("Token expired, attempting refresh first...")
            try:
                creds.refresh(Request())
                if creds.scopes and set(SCOPES).issubset(set(creds.scopes)):
                    with open(TOKEN_PATH, 'w') as f:
                        f.write(creds.to_json())
                    print(f"Token refreshed successfully. Expiry: {creds.expiry}")
                    return
                else:
                    print("Token refreshed but missing scopes. Starting full auth flow...")
            except Exception as e:
                print(f"Refresh failed ({e}). Starting full auth flow...")

    # Full OAuth flow
    print(f"\nStarting OAuth flow with {len(SCOPES)} scopes:")
    for scope in SCOPES:
        print(f"  - {scope.split('/')[-1]}")
    print()

    flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
    creds = flow.run_local_server(port=8090, prompt='consent', access_type='offline')

    os.makedirs(TOKEN_DIR, exist_ok=True)
    with open(TOKEN_PATH, 'w') as f:
        f.write(creds.to_json())

    print(f"\nAuthorization successful!")
    print(f"Token saved to: {TOKEN_PATH}")
    print(f"Expiry: {creds.expiry}")
    print(f"Scopes granted: {len(creds.scopes or SCOPES)}")


def test_connection():
    """Quick test: list Gmail labels to verify the token works."""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    if not os.path.exists(TOKEN_PATH):
        print("No token — skip test.")
        return

    creds = Credentials.from_authorized_user_file(TOKEN_PATH)
    if creds.expired and creds.refresh_token:
        from google.auth.transport.requests import Request
        creds.refresh(Request())

    service = build('gmail', 'v1', credentials=creds)
    results = service.users().labels().list(userId='me').execute()
    labels = results.get('labels', [])
    print(f"\nGmail connection test: OK ({len(labels)} labels found)")
    for label in labels[:5]:
        print(f"  - {label['name']}")
    if len(labels) > 5:
        print(f"  ... and {len(labels) - 5} more")


def main():
    import argparse
    parser = argparse.ArgumentParser(description='NanoClaw Google Workspace OAuth Setup')
    parser.add_argument('--check', action='store_true', help='Check current token status')
    parser.add_argument('--refresh-only', action='store_true', help='Only refresh existing token')
    parser.add_argument('--test', action='store_true', help='Test connection after auth')
    args = parser.parse_args()

    check_dependencies()

    if args.check:
        check_token()
        return

    if args.refresh_only:
        refresh_token()
        if args.test:
            test_connection()
        return

    authorize()
    if args.test:
        test_connection()


if __name__ == '__main__':
    main()
