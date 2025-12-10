# Files Agent

IPFS-based file management for Epistery with data wallet origin tracking.

## Features

- 📤 **Upload to IPFS** - Store files on the InterPlanetary File System
- 🔐 **Access Control** - Whitelist-based permissions for upload and management
- 🔒 **Data Wallets** - Each file gets a data wallet to prove origin and track changes
- 📁 **Folder Organization** - Hierarchical file organization
- 🖼️ **Image Processing** - Automatic thumbnails and optimization
- ⚡ **Direct Access** - No middlemen, users control their data

## Architecture

Based on `@metric-im/storage-server` but adapted for Epistery:

- Uses Epistery authentication instead of Componentry
- Integrates with Epistery white-lists for access control
- Adds data wallet tracking for file provenance
- IPFS for decentralized storage

## Configuration

Set in `epistery.json`:

```json
{
  "config": {
    "uploadList": "files::upload",    // Who can upload files
    "manageList": "files::manage",    // Who can delete/manage files
    "ipfsGateway": "https://rootz.digital/api/v0"
  }
}
```

## API Endpoints

- `GET /api/list` - List user's files
- `POST /api/upload` - Upload file to IPFS (requires `files::upload` permission)
- `GET /api/file/:cid` - Get file metadata
- `GET /api/file/:cid/download` - Download file
- `DELETE /api/file/:cid` - Delete file (requires `files::manage` permission)

## TODO

- [ ] Implement IPFS upload with data wallet creation
- [ ] Store file metadata
- [ ] Implement folder organization
- [ ] Add image thumbnail generation
- [ ] Implement file sharing via whitelist
- [ ] Add file versioning
- [ ] Implement search/filtering
