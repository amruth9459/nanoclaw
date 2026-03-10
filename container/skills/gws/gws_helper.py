#!/usr/bin/env python3
"""
Google Workspace helper script for NanoClaw container agent.
Uses Google API Python client with OAuth tokens from mounted directory.

Usage:
    python3 gws_helper.py gmail_search --query "from:boss" --max_results 10
    python3 gws_helper.py gmail_send --to "user@example.com" --subject "Hi" --body "Hello"
    python3 gws_helper.py calendar_events --days 7 --calendar_id primary
    python3 gws_helper.py drive_search --query "name contains 'report'" --max_results 10

Token directory (GWS_TOKEN_DIR env var) must contain:
    - token.json (OAuth2 refresh token)
    - credentials.json (OAuth2 client credentials)
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

TOKEN_DIR = os.environ.get('GWS_TOKEN_DIR', '/workspace/gws/tokens')


def get_credentials():
    """Load OAuth2 credentials from token directory."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
    except ImportError:
        print(json.dumps({"error": "google-auth not installed. Run: pip install google-auth google-auth-oauthlib"}))
        sys.exit(1)

    token_path = os.path.join(TOKEN_DIR, 'token.json')
    creds_path = os.path.join(TOKEN_DIR, 'credentials.json')

    if not os.path.exists(token_path):
        print(json.dumps({"error": f"token.json not found in {TOKEN_DIR}. Complete OAuth setup on host first."}))
        sys.exit(1)

    creds = Credentials.from_authorized_user_file(token_path)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(token_path, 'w') as f:
            f.write(creds.to_json())

    return creds


def gmail_search(args):
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('gmail', 'v1', credentials=creds)

    results = service.users().messages().list(
        userId='me', q=args.query, maxResults=int(args.max_results)
    ).execute()

    messages = results.get('messages', [])
    if not messages:
        print(json.dumps({"results": [], "total": 0}))
        return

    output = []
    for msg_ref in messages:
        msg = service.users().messages().get(userId='me', id=msg_ref['id'], format='metadata',
            metadataHeaders=['Subject', 'From', 'Date']).execute()

        headers = {h['name']: h['value'] for h in msg.get('payload', {}).get('headers', [])}
        output.append({
            "id": msg['id'],
            "subject": headers.get('Subject', '(no subject)'),
            "from": headers.get('From', ''),
            "date": headers.get('Date', ''),
            "snippet": msg.get('snippet', ''),
        })

    print(json.dumps({"results": output, "total": results.get('resultSizeEstimate', len(output))}))


def gmail_send(args):
    import base64
    from email.mime.text import MIMEText
    from googleapiclient.discovery import build

    creds = get_credentials()
    service = build('gmail', 'v1', credentials=creds)

    message = MIMEText(args.body)
    message['to'] = args.to
    message['subject'] = args.subject
    if hasattr(args, 'cc') and args.cc:
        message['cc'] = args.cc

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    result = service.users().messages().send(userId='me', body={'raw': raw}).execute()
    print(json.dumps({"success": True, "message_id": result['id']}))


def calendar_events(args):
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('calendar', 'v3', credentials=creds)

    now = datetime.now(timezone.utc)
    time_max = now + timedelta(days=int(args.days))

    events_result = service.events().list(
        calendarId=args.calendar_id,
        timeMin=now.isoformat(),
        timeMax=time_max.isoformat(),
        maxResults=50,
        singleEvents=True,
        orderBy='startTime',
    ).execute()

    events = events_result.get('items', [])
    output = []
    for event in events:
        start = event['start'].get('dateTime', event['start'].get('date'))
        output.append({
            "summary": event.get('summary', '(no title)'),
            "start": start,
            "end": event['end'].get('dateTime', event['end'].get('date')),
            "location": event.get('location', ''),
            "link": event.get('htmlLink', ''),
        })

    print(json.dumps({"events": output, "total": len(output)}))


def drive_search(args):
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('drive', 'v3', credentials=creds)

    results = service.files().list(
        q=args.query,
        pageSize=int(args.max_results),
        fields='files(id, name, mimeType, webViewLink, modifiedTime, size)',
    ).execute()

    files = results.get('files', [])
    output = []
    for f in files:
        output.append({
            "name": f.get('name'),
            "type": f.get('mimeType'),
            "link": f.get('webViewLink', ''),
            "modified": f.get('modifiedTime', ''),
            "size": f.get('size', ''),
        })

    print(json.dumps({"files": output, "total": len(output)}))


def main():
    parser = argparse.ArgumentParser(description='Google Workspace helper')
    subparsers = parser.add_subparsers(dest='action')

    p_search = subparsers.add_parser('gmail_search')
    p_search.add_argument('--query', required=True)
    p_search.add_argument('--max_results', default='10')

    p_send = subparsers.add_parser('gmail_send')
    p_send.add_argument('--to', required=True)
    p_send.add_argument('--subject', required=True)
    p_send.add_argument('--body', required=True)
    p_send.add_argument('--cc', default='')

    p_cal = subparsers.add_parser('calendar_events')
    p_cal.add_argument('--days', default='7')
    p_cal.add_argument('--calendar_id', default='primary')

    p_drive = subparsers.add_parser('drive_search')
    p_drive.add_argument('--query', required=True)
    p_drive.add_argument('--max_results', default='10')

    args = parser.parse_args()

    if not args.action:
        parser.print_help()
        sys.exit(1)

    actions = {
        'gmail_search': gmail_search,
        'gmail_send': gmail_send,
        'calendar_events': calendar_events,
        'drive_search': drive_search,
    }

    try:
        actions[args.action](args)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
