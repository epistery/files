/**
 * Files Agent - IPFS file management with data wallet origin tracking
 *
 * Provides Dropbox-like functionality where:
 * - Files are stored in IPFS
 * - Each file gets a data wallet to prove origin and track changes
 * - Access control through Epistery white-lists
 * - Bypasses all middlemen - users control their data
 */
import express from 'express';
import fileUpload from 'express-fileupload';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default class FilesAgent {
    constructor(config = {}) {
        this.config = config;
        this.epistery = null;

        // IPFS configuration (same as message-board)
        this.ipfsUrl = null;
        this.ipfsGateway = null;
    }

    /**
     * Get domain-specific data directory
     */
    getDataDir(domain) {
        if (!domain) {
            domain = 'default';
        }
        const dataDir = join(__dirname, 'data', domain);
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }
        return dataDir;
    }

    /**
     * Upload data to IPFS (same pattern as message-board)
     */
    async uploadToIPFS(buffer, filename) {
        if (!this.ipfsUrl) {
            console.warn('[Files] IPFS URL not configured, skipping IPFS upload');
            return null;
        }

        try {
            const formData = new FormData();
            const blob = new Blob([buffer], { type: 'application/octet-stream' });
            formData.append('file', blob, filename);

            const response = await fetch(`${this.ipfsUrl}/add`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[Files] IPFS upload failed with status: ${response.status}`);
                console.error(`[Files] Error details: ${errorText}`);
                console.error(`[Files] File size: ${buffer.length} bytes`);
                return null;
            }

            const result = await response.json();
            const ipfsHash = result.Hash;
            console.log(`[Files] Uploaded to IPFS: ${ipfsHash}`);

            return {
                hash: ipfsHash,
                url: `${this.ipfsGateway}/ipfs/${ipfsHash}`
            };
        } catch (error) {
            console.error('[Files] IPFS upload error:', error);
            return null;
        }
    }

    /**
     * Attach agent routes to the provided router
     * @param {express.Router} router - Express router instance
     */
    attach(router) {

        // Initialize IPFS config from environment (same as message-board)
        router.use((req, res, next) => {
            if (!this.epistery) {
                this.epistery = req.app.locals.epistery;
            }
            if (!this.ipfsUrl) {
                this.ipfsUrl = process.env.IPFS_URL || 'https://rootz.digital/api/v0';
                this.ipfsGateway = process.env.IPFS_GATEWAY || 'https://rootz.digital';
                console.log('[Files] IPFS configured:', this.ipfsUrl);
            }
            next();
        });

        // File upload middleware
        router.use(fileUpload({
            limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
            abortOnLimit: true,
            createParentPath: true,
            useTempFiles: true,
            tempFileDir: '/tmp/'
        }));

        // Serve static files
        router.use('/public', express.static(join(__dirname, 'public')));
        router.get('/icon.svg', (req, res) => {
            res.sendFile(join(__dirname, 'icon.svg'));
        });

        // Main UI
        router.get('/', (req, res) => {
            res.sendFile(join(__dirname, 'public', 'index.html'));
        });

        // Widget endpoint
        router.get('/widget', (req, res) => {
            res.send('<div>Files widget - Coming soon</div>');
        });

        // Admin page
        router.get('/admin', (req, res) => {
            res.sendFile(join(__dirname, 'public', 'admin.html'));
        });

        // API routes - inline instead of separate method
        const apiRouter = express.Router();

        // List files in a folder
        apiRouter.get('/list', async (req, res) => {
            try {
                const domain = req.hostname || 'localhost';
                const folder = req.query.folder || '';
                const dataDir = this.getDataDir(domain);
                const folderPath = join(dataDir, folder);

                if (!existsSync(folderPath)) {
                    return res.json({ files: [], folders: [] });
                }

                const items = readdirSync(folderPath, { withFileTypes: true });
                const files = [];
                const folders = [];

                for (const item of items) {
                    if (item.isDirectory()) {
                        folders.push({ name: item.name, path: join(folder, item.name) });
                    } else if (item.name.endsWith('.json')) {
                        // Read file metadata
                        const metaPath = join(folderPath, item.name);
                        const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
                        files.push(metadata);
                    }
                }

                res.json({ files, folders });
            } catch (error) {
                console.error('[Files] List error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Upload file
        apiRouter.post('/upload', async (req, res) => {
            try {
                if (!req.files || !req.files.file) {
                    return res.status(400).json({ error: 'No file uploaded' });
                }

                // Check upload permission
                if (!req.episteryClient) {
                    return res.status(401).json({ error: 'Not authenticated' });
                }

                const uploadList = this.config.uploadList || 'files::upload';
                const canUpload = await this.epistery.isListed(
                    req.episteryClient.address,
                    uploadList
                );

                if (!canUpload) {
                    return res.status(403).json({ error: 'Not authorized to upload' });
                }

                const file = req.files.file;
                const folder = (req.body && req.body.folder) ? req.body.folder : '';
                const domain = req.hostname || 'localhost';

                // Read file data (handles both temp files and in-memory)
                let fileData;
                if (file.tempFilePath) {
                    // Large file stored as temp file
                    const fs = await import('fs/promises');
                    fileData = await fs.readFile(file.tempFilePath);
                } else {
                    // Small file in memory
                    fileData = file.data;
                }

                // Upload to IPFS
                console.log(`[Files] Uploading ${file.name} (${fileData.length} bytes) to IPFS...`);
                const ipfsResult = await this.uploadToIPFS(fileData, file.name);

                if (!ipfsResult) {
                    const sizeKB = (fileData.length / 1024).toFixed(2);
                    console.error(`[Files] Failed to upload ${file.name} (${sizeKB} KB)`);
                    return res.status(500).json({
                        error: 'IPFS upload failed',
                        details: 'File may be too large for the IPFS gateway (limit appears to be ~128KB)',
                        size: fileData.length,
                        suggestion: 'Try a smaller file or contact admin to increase gateway limits'
                    });
                }

                // Create file metadata (data wallet)
                const fileId = crypto.randomBytes(16).toString('hex');
                const metadata = {
                    id: fileId,
                    name: file.name,
                    size: file.size,
                    mimetype: file.mimetype,
                    ipfsHash: ipfsResult.hash,
                    ipfsUrl: ipfsResult.url,
                    folder: folder,
                    uploadedBy: req.episteryClient.address,
                    uploadedAt: new Date().toISOString(),
                    hash: crypto.createHash('md5').update(fileData).digest('hex')
                };

                // Save metadata to disk
                const dataDir = this.getDataDir(domain);
                const folderPath = join(dataDir, folder);
                if (!existsSync(folderPath)) {
                    mkdirSync(folderPath, { recursive: true });
                }

                const metaPath = join(folderPath, `${fileId}.json`);
                writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

                res.json(metadata);
            } catch (error) {
                console.error('[Files] Upload error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Download file from IPFS
        apiRouter.get('/file/:id/download', async (req, res) => {
            try {
                const { id } = req.params;
                const domain = req.hostname || 'localhost';
                const dataDir = this.getDataDir(domain);

                // Find metadata file
                const metaPath = this.findMetadataFile(dataDir, id);
                if (!metaPath) {
                    return res.status(404).json({ error: 'File not found' });
                }

                const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));

                // Redirect to IPFS gateway
                res.redirect(metadata.ipfsUrl);
            } catch (error) {
                console.error('[Files] Download error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Delete file
        apiRouter.delete('/file/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const domain = req.hostname || 'localhost';

                // Check manage permission
                if (!req.episteryClient) {
                    return res.status(401).json({ error: 'Not authenticated' });
                }

                const manageList = this.config.manageList || 'files::manage';
                const canManage = await this.epistery.isListed(
                    req.episteryClient.address,
                    manageList
                );

                if (!canManage) {
                    return res.status(403).json({ error: 'Not authorized to manage files' });
                }

                const dataDir = this.getDataDir(domain);
                const metaPath = this.findMetadataFile(dataDir, id);

                if (!metaPath) {
                    return res.status(404).json({ error: 'File not found' });
                }

                // Delete metadata file (IPFS content remains immutable)
                unlinkSync(metaPath);

                res.json({ success: true });
            } catch (error) {
                console.error('[Files] Delete error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        router.use('/api', apiRouter);
    }

    /**
     * Find metadata file by ID (recursively search folders)
     */
    findMetadataFile(dir, id) {
        const items = readdirSync(dir, { withFileTypes: true });

        for (const item of items) {
            const fullPath = join(dir, item.name);

            if (item.isDirectory()) {
                const found = this.findMetadataFile(fullPath, id);
                if (found) return found;
            } else if (item.name === `${id}.json`) {
                return fullPath;
            }
        }

        return null;
    }
}
