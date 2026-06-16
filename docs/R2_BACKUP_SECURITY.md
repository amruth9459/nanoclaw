# R2 Backup Security: Write-Only Token Setup

## Security Architecture

NanoClaw uses a two-token architecture for R2 backups:

1. **r2-backup-writeonly**: Used by automated backup.sh (PutObject only, no delete)
2. **r2**: Full access (read/write/delete) for manual restore and maintenance only

## Creating the Write-Only Token

### Step 1: Access Cloudflare R2 Dashboard
1. Log in to Cloudflare dashboard
2. Navigate to R2 Object Storage
3. Select the `nanoclaw-backup` bucket
4. Go to Settings > R2 API Tokens

### Step 2: Create Write-Only Token
Click "Create API Token" and configure:

**Token Name**: `nanoclaw-backup-writeonly`

**Permissions**:
- Object Read and Write (required for rclone copy operations)
- Do NOT enable Admin Read and Write

**Bucket Scope**:
- Select specific bucket: `nanoclaw-backup`

**TTL**: No expiration (or set to 1 year with calendar reminder for rotation)

**Important**: The token MUST have:
- `s3:PutObject` (write new objects)
- `s3:GetObject` (verify existing objects during rclone copy)
- `s3:ListBucket` (list bucket contents for --update checks)

The token MUST NOT have:
- `s3:DeleteObject` (prevents deletion)
- `s3:DeleteBucket` (prevents bucket deletion)

### Step 3: Record Token Credentials
After creating the token, Cloudflare will display:
- Access Key ID
- Secret Access Key
- Endpoint URL (format: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)

**Security**: Store these credentials in your password manager immediately. Cloudflare will not show the secret again.

### Step 4: Configure rclone

Edit `~/.config/rclone/rclone.conf`:

```ini
[r2-backup-writeonly]
type = s3
provider = Cloudflare
access_key_id = <WRITEONLY_ACCESS_KEY_ID>
secret_access_key = <WRITEONLY_SECRET_KEY>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
acl = private
```

### Step 5: Verify Write-Only Permissions

Test that the token can write:
```bash
echo "test" > /tmp/test-write.txt
rclone copy /tmp/test-write.txt r2-backup-writeonly:nanoclaw-backup/test/
```

Test that the token CANNOT delete (should fail with Access Denied):
```bash
rclone delete r2-backup-writeonly:nanoclaw-backup/test/test-write.txt
# Expected: ERROR : test/test-write.txt: Failed to delete: AccessDenied
```

If delete succeeds, the token has too many permissions — recreate with stricter settings.

Or use the automated verification script:
```bash
./scripts/verify-r2-writeonly.sh
```

### Step 6: Update Backup Script

The patch changes backup.sh to use `r2-backup-writeonly` by default:
```bash
R2_REMOTE="${R2_REMOTE:-r2-backup-writeonly}"
```

## Manual Maintenance with Full-Access Token

For snapshot pruning or emergency restore, temporarily create the full-access remote:

### One-Time Prune Operation
```bash
# 1. Create temporary full-access remote
rclone config create r2-temp s3 \
  provider=Cloudflare \
  access_key_id=<FULL_ACCESS_KEY> \
  secret_access_key=<FULL_ACCESS_SECRET> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

# 2. List old snapshots (older than 90 days)
CUTOFF=$(date -v-90d '+%Y-%m-%d' 2>/dev/null || date -d '90 days ago' '+%Y-%m-%d')
rclone lsf r2-temp:nanoclaw-backup/snapshots/ --dirs-only | while read dir; do
  [[ "${dir%/}" < "$CUTOFF" ]] && echo "Old: ${dir}"
done

# 3. Delete old snapshots after review
rclone lsf r2-temp:nanoclaw-backup/snapshots/ --dirs-only | while read dir; do
  [[ "${dir%/}" < "$CUTOFF" ]] && rclone purge "r2-temp:nanoclaw-backup/snapshots/${dir%/}"
done

# 4. Remove full-access remote immediately
rclone config delete r2-temp
```

### Emergency Restore
Use restore.sh with the full-access token (stored in password manager).

## Threat Model

**Without write-only token** (previous state):
- Compromised agent with rclone access can wipe all backups
- Malicious code in backup.sh could delete historical snapshots
- Accidental `rclone sync` instead of `rclone copy` wipes remote data

**With write-only token**:
- Compromised agent can only add data, not delete
- Blast radius limited to storage quota exhaustion
- Historical snapshots are immutable from automated context
- Restore operations still possible via separate full-access token

## Compliance Checklist

- [ ] Write-only token created in Cloudflare dashboard
- [ ] Token permissions verified (no delete capability)
- [ ] rclone.conf updated with r2-backup-writeonly remote
- [ ] Test write succeeds (rclone copy)
- [ ] Test delete fails (rclone delete returns Access Denied)
- [ ] backup.sh patch applied (R2_REMOTE points to write-only)
- [ ] Full-access token stored in password manager
- [ ] Full-access token removed from rclone.conf (keep in password manager only)
- [ ] backup.sh tested successfully with new remote
- [ ] Documentation added to MEMORY.md

## Rotation Schedule

**Write-only token**: Rotate annually (set calendar reminder)
**Full-access token**: Rotate after each use for maintenance operations

## Related

- [[nc-sec-09-r2-token-security|Security Review: R2 Backup Token Least Privilege]]
- [[R2_WRITEONLY_TOKEN_GUIDE|R2 Write-Only Token Implementation Guide]]
- [[nanoclaw-sandbox-workflow|NanoClaw Sandbox Workflow]]
- [[HARDENING_CHECKLIST|NanoClaw Security Hardening Checklist]]
- [[DEPLOYMENT-INSTRUCTIONS|Lexios Nginx SSL Infrastructure Deployment]]
