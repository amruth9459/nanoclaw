#!/usr/bin/env python3
"""
Google Workspace helper script for NanoClaw container agent.
Uses Google API Python client with OAuth tokens from mounted directory.

Usage:
    python3 gws_helper.py gmail_search --query "from:boss" --max_results 10
    python3 gws_helper.py gmail_send --to "user@example.com" --subject "Hi" --body "Hello"
    python3 gws_helper.py calendar_events --days 7 --calendar_id primary
    python3 gws_helper.py drive_search --query "name contains 'report'" --max_results 10
    python3 gws_helper.py gmail_categorize --query "category:promotions" --max_results 50
    python3 gws_helper.py gmail_batch_trash --message_ids '["id1","id2"]'
    python3 gws_helper.py gmail_batch_archive --message_ids '["id1","id2"]'

Token directory (GWS_TOKEN_DIR env var) must contain:
    - token.json (OAuth2 refresh token)
    - credentials.json (OAuth2 client credentials)
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
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


def gmail_categorize(args):
    """Search Gmail and group results by sender domain for cleanup review."""
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('gmail', 'v1', credentials=creds)

    max_results = min(int(args.max_results), 100)
    results = service.users().messages().list(
        userId='me', q=args.query, maxResults=max_results
    ).execute()

    messages = results.get('messages', [])
    if not messages:
        print(json.dumps({"domains": {}, "total": 0, "message_ids": []}))
        return

    domains = defaultdict(lambda: {"count": 0, "examples": [], "ids": []})
    all_ids = []

    for msg_ref in messages:
        msg = service.users().messages().get(userId='me', id=msg_ref['id'], format='metadata',
            metadataHeaders=['Subject', 'From', 'Date', 'List-Unsubscribe']).execute()

        headers = {h['name']: h['value'] for h in msg.get('payload', {}).get('headers', [])}
        from_addr = headers.get('From', '')
        subject = headers.get('Subject', '(no subject)')
        has_unsubscribe = 'List-Unsubscribe' in headers

        # Extract domain from email address
        email_match = re.search(r'<([^>]+)>|[\w.+-]+@[\w.-]+', from_addr)
        if email_match:
            email = email_match.group(1) or email_match.group(0)
            domain = email.split('@')[-1] if '@' in email else 'unknown'
        else:
            domain = 'unknown'

        entry = domains[domain]
        entry["count"] += 1
        entry["ids"].append(msg_ref['id'])
        if len(entry["examples"]) < 3:
            entry["examples"].append(subject[:80])
        if has_unsubscribe:
            entry["is_newsletter"] = True

        all_ids.append(msg_ref['id'])

    # Convert to serializable dict
    output = {}
    for domain, data in sorted(domains.items(), key=lambda x: -x[1]["count"]):
        output[domain] = {
            "count": data["count"],
            "examples": data["examples"],
            "ids": data["ids"],
            "is_newsletter": data.get("is_newsletter", False),
        }

    print(json.dumps({
        "domains": output,
        "total": len(all_ids),
        "total_estimate": results.get('resultSizeEstimate', len(all_ids)),
        "message_ids": all_ids,
    }))


MAX_BATCH = 100


def gmail_batch_trash(args):
    """Move messages to Trash via batchModify. Hard cap 100 messages."""
    from googleapiclient.discovery import build
    creds = get_credentials()

    message_ids = json.loads(args.message_ids)
    if not isinstance(message_ids, list):
        print(json.dumps({"error": "message_ids must be a JSON array"}))
        sys.exit(1)
    if len(message_ids) > MAX_BATCH:
        print(json.dumps({"error": f"Exceeds hard cap of {MAX_BATCH} messages (got {len(message_ids)})"}))
        sys.exit(1)
    if len(message_ids) == 0:
        print(json.dumps({"error": "Empty message_ids list"}))
        sys.exit(1)

    service = build('gmail', 'v1', credentials=creds)
    service.users().messages().batchModify(userId='me', body={
        'ids': message_ids,
        'addLabelIds': ['TRASH'],
    }).execute()

    print(json.dumps({"success": True, "trashed": len(message_ids)}))


def gmail_batch_archive(args):
    """Archive messages (remove INBOX label) via batchModify. Hard cap 100 messages."""
    from googleapiclient.discovery import build
    creds = get_credentials()

    message_ids = json.loads(args.message_ids)
    if not isinstance(message_ids, list):
        print(json.dumps({"error": "message_ids must be a JSON array"}))
        sys.exit(1)
    if len(message_ids) > MAX_BATCH:
        print(json.dumps({"error": f"Exceeds hard cap of {MAX_BATCH} messages (got {len(message_ids)})"}))
        sys.exit(1)
    if len(message_ids) == 0:
        print(json.dumps({"error": "Empty message_ids list"}))
        sys.exit(1)

    service = build('gmail', 'v1', credentials=creds)
    service.users().messages().batchModify(userId='me', body={
        'ids': message_ids,
        'removeLabelIds': ['INBOX'],
    }).execute()

    print(json.dumps({"success": True, "archived": len(message_ids)}))


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

    p_categorize = subparsers.add_parser('gmail_categorize')
    p_categorize.add_argument('--query', required=True)
    p_categorize.add_argument('--max_results', default='50')

    p_trash = subparsers.add_parser('gmail_batch_trash')
    p_trash.add_argument('--message_ids', required=True)

    p_archive = subparsers.add_parser('gmail_batch_archive')
    p_archive.add_argument('--message_ids', required=True)

    args = parser.parse_args()

    if not args.action:
        parser.print_help()
        sys.exit(1)

    actions = {
        'gmail_search': gmail_search,
        'gmail_send': gmail_send,
        'calendar_events': calendar_events,
        'drive_search': drive_search,
        'gmail_categorize': gmail_categorize,
        'gmail_batch_trash': gmail_batch_trash,
        'gmail_batch_archive': gmail_batch_archive,
    }

    try:
        actions[args.action](args)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
