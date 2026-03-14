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


def keep_list_notes(args):
    """List Google Keep notes with optional label filter."""
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('keep', 'v1', credentials=creds)

    filter_str = ''
    if hasattr(args, 'label') and args.label:
        filter_str = f'labels.name = "{args.label}"'

    params = {'pageSize': int(args.max_results)}
    if filter_str:
        params['filter'] = filter_str

    results = service.notes().list(**params).execute()
    notes = results.get('notes', [])

    output = []
    for note in notes:
        if not args.archived and note.get('trashed'):
            continue
        output.append({
            "name": note.get('name', ''),
            "title": note.get('title', '(untitled)'),
            "createTime": note.get('createTime', ''),
            "updateTime": note.get('updateTime', ''),
            "trashed": note.get('trashed', False),
        })

    print(json.dumps({"notes": output, "total": len(output)}))


def keep_get_note(args):
    """Get full content of a Google Keep note by ID."""
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('keep', 'v1', credentials=creds)

    note_id = args.note_id
    if not note_id.startswith('notes/'):
        note_id = f'notes/{note_id}'

    note = service.notes().get(name=note_id).execute()

    # Extract text content from body
    body = note.get('body', {})
    content_type = 'text'
    text_content = ''
    items = []

    if 'text' in body:
        text_content = body['text'].get('text', '')
    elif 'list' in body:
        content_type = 'list'
        for item in body['list'].get('listItems', []):
            items.append({
                "text": item.get('text', {}).get('text', ''),
                "checked": item.get('checked', False),
            })

    output = {
        "name": note.get('name', ''),
        "title": note.get('title', '(untitled)'),
        "content_type": content_type,
        "createTime": note.get('createTime', ''),
        "updateTime": note.get('updateTime', ''),
        "trashed": note.get('trashed', False),
    }

    if content_type == 'text':
        output["text"] = text_content
    else:
        output["items"] = items

    print(json.dumps(output))


def keep_list_items(args):
    """Extract task items from a Google Keep list note."""
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('keep', 'v1', credentials=creds)

    note_id = args.note_id
    if not note_id.startswith('notes/'):
        note_id = f'notes/{note_id}'

    note = service.notes().get(name=note_id).execute()
    body = note.get('body', {})

    if 'list' not in body:
        print(json.dumps({"error": "Note is not a list/checklist", "note_title": note.get('title', '')}))
        return

    unchecked_only = args.unchecked_only.lower() == 'true' if hasattr(args, 'unchecked_only') else True
    items = []
    for item in body['list'].get('listItems', []):
        checked = item.get('checked', False)
        if unchecked_only and checked:
            continue
        items.append({
            "text": item.get('text', {}).get('text', ''),
            "checked": checked,
        })

    print(json.dumps({
        "note_title": note.get('title', '(untitled)'),
        "items": items,
        "total": len(items),
    }))


def keep_search(args):
    """Search Google Keep notes by text content."""
    from googleapiclient.discovery import build
    creds = get_credentials()
    service = build('keep', 'v1', credentials=creds)

    # Keep API doesn't have a direct search — list all and filter client-side
    all_notes = []
    page_token = None
    while True:
        params = {'pageSize': 100}
        if page_token:
            params['pageToken'] = page_token
        results = service.notes().list(**params).execute()
        all_notes.extend(results.get('notes', []))
        page_token = results.get('nextPageToken')
        if not page_token:
            break

    query_lower = args.query.lower()
    max_results = int(args.max_results)
    matched = []

    for note in all_notes:
        if note.get('trashed'):
            continue

        title = note.get('title', '')
        body = note.get('body', {})
        body_text = ''
        if 'text' in body:
            body_text = body['text'].get('text', '')
        elif 'list' in body:
            body_text = ' '.join(
                item.get('text', {}).get('text', '')
                for item in body['list'].get('listItems', [])
            )

        if query_lower in title.lower() or query_lower in body_text.lower():
            matched.append({
                "name": note.get('name', ''),
                "title": title or '(untitled)',
                "snippet": (body_text[:200] + '...') if len(body_text) > 200 else body_text,
                "updateTime": note.get('updateTime', ''),
            })
            if len(matched) >= max_results:
                break

    print(json.dumps({"results": matched, "total": len(matched)}))


# TODO Phase 2: keep_check_item(args) — toggle checklist item
# TODO Phase 2: keep_add_item(args) — add item to checklist note


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
