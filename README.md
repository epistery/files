# Files Agent

File management for Epistery with Storj storage and data wallet origin tracking.

## Features

- **Upload to Storj** - Store files in S3-compatible object storage
- **Access Control** - ACL-based permissions for upload and management
- **Data Wallets** - Each file gets a data wallet to prove origin and track changes
- **Folder Organization** - Hierarchical folders with `.folder` placeholders in storage
- **Image Previews** - Thumbnail grid with lazy-loaded image previews
- **Dual View Modes** - Grid (zoomable) and list views with context menus
- **Rename** - Rename files from context menu or details pane
- **MCP Tools** - 5 tools for AI integration (list, metadata, create folder, rename, delete)

## Architecture

- Uses Epistery authentication and DomainACL for access control
- Storj storage via StorageFactory (raw writes for binary, encrypted for metadata)
- Remote `._i` records are the sole source of truth — no local per-file JSON
- In-memory cache (`_domainCache`) with `files-cache.json` for fast cold start
- On startup, loads cache file first, then reconciles with a full storage scan
- Single-file HTML UI following epistery convention (`public/index.html`)

## Configuration

Set in `epistery.json`:

```json
{
  "config": {
    "uploadList": "files::upload",
    "manageList": "files::manage"
  }
}
```

Storj credentials are configured in the admin panel under Storj Storage, or in the domain `config.ini` `[storj]` section.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/list?folder=` | List files and folders in a directory |
| `POST` | `/api/upload` | Upload file (multipart, requires editor access) |
| `GET` | `/api/file/:id/meta` | Get file metadata JSON |
| `GET` | `/api/file/:id/preview` | Serve file inline (images, PDF, etc.) |
| `GET` | `/api/file/:id/download` | Download file as attachment |
| `PATCH` | `/api/file/:id` | Rename file (`{ newName }`) |
| `DELETE` | `/api/file/:id` | Delete file (owner or admin) |
| `POST` | `/api/folder` | Create folder (`{ name, parentFolder }`) |
| `DELETE` | `/api/folder?path=` | Delete empty folder |

## MCP Tools

| Tool | Description |
|------|-------------|
| `files_list` | List files/folders in a directory |
| `files_metadata` | Get file metadata by ID |
| `files_create_folder` | Create a folder |
| `files_rename` | Rename a file |
| `files_delete` | Delete a file |

## Storage Notes

Binary file content is written through raw storage (bypassing EncryptedStorage) to avoid text encoding corruption. Metadata files (`._i` wallet data, `.folder` placeholders) use the encrypted storage path since they are JSON text.

### Data Flow (v0.3.0)

The `._i` record in Storj is the single source of truth for every file. Local state is limited to `files-cache.json` — a serialized snapshot of the in-memory cache for fast cold starts. On server restart the cache is loaded from disk, then a full `listAllFiles()` scan reconciles against remote storage. Mutations (upload, rename, delete) update the `._i` record in Storj first, then the in-memory cache, then persist the cache file.
