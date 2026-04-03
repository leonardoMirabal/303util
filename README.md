# TB-303 Companion

## Google Drive backup sync

The app now supports frictionless Google Drive backup/restore (after one-time app setup):

1. Add a Google OAuth Web Client ID in your environment:
   - `VITE_GOOGLE_CLIENT_ID=...`
2. Start the app and open `Menu...`
3. Click `Connect Google Drive`

Behavior:
- On connect, the app checks Drive for `TB-303 Companion Backups/tb303-backup.json`
- If Drive backup is newer, it restores that data into local IndexedDB
- Local edits/saves continue in IndexedDB and are auto-backed up to Drive shortly after changes
- `Backup to Google Drive now` triggers an immediate backup
