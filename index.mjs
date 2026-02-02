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
import { existsSync, unlinkSync } from 'fs';
import crypto from 'crypto';
import { Config } from 'epistery';
import StorageFactory from '../epistery-host/utils/storage/StorageFactory.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default class FilesAgent {
    constructor(config = {}) {
        this.config = config;
        this.epistery = null;
        this.storage = null;
    }

    /**
     * Read JSON file from domain config directory
     */
    readJson(domain, filename) {
        const config = new Config();
        config.setPath(domain);
        try {
            const data = config.readFile(filename);
            return JSON.parse(data.toString());
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    /**
     * Write JSON file to domain config directory
     */
    writeJson(domain, filename, data) {
        const config = new Config();
        config.setPath(domain);
        config.save();
        config.writeFile(filename, JSON.stringify(data, null, 2));
    }

    /**
     * Delete JSON file from domain config directory
     */
    deleteJson(domain, filename) {
        const config = new Config();
        config.setPath(domain);
        try {
            const filepath = join(config.currentDir, filename);
            if (existsSync(filepath)) {
                unlinkSync(filepath);
                return true;
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        return false;
    }

    /**
     * Get file index (tracks all files and folders)
     */
    getFileIndex(domain) {
        return this.readJson(domain, 'files-index.json') || { files: {}, folders: [] };
    }

    /**
     * Save file index
     */
    saveFileIndex(domain, index) {
        this.writeJson(domain, 'files-index.json', index);
    }

    /**
     * Get file metadata by ID
     */
    getFile(domain, fileId) {
        return this.readJson(domain, `files-${fileId}.json`);
    }

    /**
     * Save file metadata
     */
    saveFile(domain, metadata) {
        this.writeJson(domain, `files-${metadata.id}.json`, metadata);
    }

    /**
     * Delete file metadata
     */
    deleteFile(domain, fileId) {
        return this.deleteJson(domain, `files-${fileId}.json`);
    }

    /**
     * Get or initialize storage for a domain
     */
    async getStorage(domain) {
        if (!this.storage) {
            this.storage = await StorageFactory.create(null, domain, 'files');
        }
        return this.storage;
    }

    /**
     * Get permissions using DomainACL
     */
    async getPermissions(req) {
        const result = { admin: false, edit: false, read: true };

        // Everyone has read access by default
        if (!req.episteryClient || !req.domainAcl) {
            return result;
        }

        try {
            const access = await req.domainAcl.checkAgentAccess('@epistery/files', req.episteryClient.address, req.hostname);
            result.admin = access.level >= 3;
            result.edit = access.level >= 2;  // editors and admins can upload/manage
            return result;
        } catch (error) {
            console.error('[Files] ACL check error:', error);
        }
        return result;
    }

    /**
     * Attach agent routes to the provided router
     * @param {express.Router} router - Express router instance
     */
    attach(router) {

        // Initialize domain and epistery from environment
        router.use((req, res, next) => {
            req.domain = req.hostname || 'localhost';
            if (!this.epistery) {
                this.epistery = req.app.locals.epistery;
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

        // Status endpoint
        router.get('/status', async (req, res) => {
            try {
                const index = this.getFileIndex(req.domain);
                const storage = await this.getStorage(req.domain);
                res.json({
                    agent: 'files',
                    version: '1.0.0',
                    fileCount: Object.keys(index.files).length,
                    folderCount: index.folders.length,
                    storage: storage.constructor.name
                });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        // API routes - inline instead of separate method
        const apiRouter = express.Router();

        // Create folder
        apiRouter.post('/folder', async (req, res) => {
            try {
                if (!req.episteryClient) {
                    return res.status(401).json({ error: 'Not authenticated' });
                }

                const permissions = await this.getPermissions(req);
                if (!permissions.edit) {
                    return res.status(403).json({ error: 'Not authorized to create folders. Editor access required.' });
                }

                const { name, parentFolder } = req.body;
                if (!name) {
                    return res.status(400).json({ error: 'Folder name is required' });
                }

                // Validate folder name
                if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
                    return res.status(400).json({ error: 'Invalid folder name. Use only letters, numbers, hyphens, and underscores.' });
                }

                const domain = req.hostname || 'localhost';
                const folderPath = parentFolder ? `${parentFolder}/${name}` : name;

                // Create a placeholder file to establish the folder in storage
                const storage = await this.getStorage(domain);
                const placeholderKey = `${folderPath}/.folder`;
                const placeholderMeta = {
                    _created: new Date().toISOString(),
                    _createdBy: req.episteryClient.address,
                    type: 'application/x-directory',
                    name: name,
                    folder: parentFolder || ''
                };

                await storage.writeFile(placeholderKey, JSON.stringify(placeholderMeta, null, 2));

                res.json({
                    success: true,
                    folder: {
                        name,
                        path: folderPath,
                        createdBy: req.episteryClient.address
                    }
                });
            } catch (error) {
                console.error('[Files] Create folder error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Delete folder
        apiRouter.delete('/folder', async (req, res) => {
            try {
                if (!req.episteryClient) {
                    return res.status(401).json({ error: 'Not authenticated' });
                }

                const permissions = await this.getPermissions(req);
                if (!permissions.admin) {
                    return res.status(403).json({ error: 'Only admins can delete folders.' });
                }

                const { path: folderPath } = req.query;
                if (!folderPath) {
                    return res.status(400).json({ error: 'Folder path is required' });
                }

                const domain = req.hostname || 'localhost';
                const index = this.getFileIndex(domain);

                // Find all files in this folder and subfolders
                const filesToDelete = Object.values(index.files)
                    .filter(f => f.folder === folderPath || f.folder.startsWith(folderPath + '/'));

                if (filesToDelete.length > 0) {
                    return res.status(400).json({
                        error: 'Folder is not empty. Delete all files first.',
                        fileCount: filesToDelete.length
                    });
                }

                // Delete folder placeholder
                const storage = await this.getStorage(domain);
                await storage.deleteFile(`${folderPath}/.folder`);

                res.json({ success: true, deleted: folderPath });
            } catch (error) {
                console.error('[Files] Delete folder error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // List files in a folder
        apiRouter.get('/list', async (req, res) => {
            try {
                const domain = req.hostname || 'localhost';
                const folder = req.query.folder || '';
                const index = this.getFileIndex(domain);

                // Filter files by folder
                const files = Object.values(index.files)
                    .filter(f => f.folder === folder)
                    .map(f => this.getFile(domain, f.id))
                    .filter(Boolean);

                // Get unique subfolders
                const folders = [...new Set(
                    Object.values(index.files)
                        .filter(f => f.folder.startsWith(folder) && f.folder !== folder)
                        .map(f => {
                            const relativePath = folder ? f.folder.slice(folder.length + 1) : f.folder;
                            return relativePath.split('/')[0];
                        })
                        .filter(Boolean)
                )].map(name => ({
                    name,
                    path: folder ? `${folder}/${name}` : name
                }));

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

                if (!req.episteryClient) {
                    return res.status(401).json({ error: 'Not authenticated' });
                }

                // Check permissions - editors (level 2) and above can upload
                const permissions = await this.getPermissions(req);
                if (!permissions.edit) {
                    return res.status(403).json({ error: 'Not authorized to upload. Editor access required.' });
                }

                const file = req.files.file;
                const folder = (req.body && req.body.folder) ? req.body.folder : '';
                const domain = req.hostname || 'localhost';

                // Read file data
                let fileData;
                if (file.tempFilePath) {
                    const fs = await import('fs/promises');
                    fileData = await fs.readFile(file.tempFilePath);
                } else {
                    fileData = file.data;
                }

                // Generate file ID and keys
                const fileId = crypto.randomBytes(16).toString('hex');
                const keyBase = folder ? `${folder}/${fileId}` : fileId;
                const ext = file.name.split('.').pop() || 'bin';
                const fileKey = `${keyBase}.${ext}`;
                const metaKey = `${keyBase}._i`;

                // Upload raw file to Storj storage
                console.log(`[Files] Uploading ${file.name} (${fileData.length} bytes) to storage...`);
                const storage = await this.getStorage(domain);

                try {
                    // Save raw file
                    await storage.writeFile(fileKey, fileData);
                    console.log(`[Files] Uploaded raw file: ${fileKey}`);

                    // Create data wallet metadata
                    const now = new Date().toISOString();
                    const dataWallet = {
                        _created: now,
                        _createdBy: req.episteryClient.address,
                        _modified: now,
                        _modifiedBy: req.episteryClient.address,
                        _hash: crypto.createHash('md5').update(fileData).digest('hex'),
                        _ext: ext,
                        name: file.name,
                        type: file.mimetype,
                        size: file.size,
                        originalFileKey: fileKey,
                        folder: folder
                    };

                    // Save metadata
                    await storage.writeFile(metaKey, JSON.stringify(dataWallet, null, 2));
                    console.log(`[Files] Uploaded metadata: ${metaKey}`);
                } catch (error) {
                    console.error(`[Files] Storage upload failed:`, error);
                    return res.status(500).json({
                        error: 'Storage upload failed',
                        details: error.message
                    });
                }

                // Create file metadata for index
                const metadata = {
                    id: fileId,
                    name: file.name,
                    size: file.size,
                    mimetype: file.mimetype,
                    keyBase: keyBase,
                    fileKey: fileKey,
                    folder: folder,
                    uploadedBy: req.episteryClient.address,
                    uploadedAt: new Date().toISOString(),
                    hash: crypto.createHash('md5').update(fileData).digest('hex')
                };

                // Save file metadata
                this.saveFile(domain, metadata);

                // Update index
                const index = this.getFileIndex(domain);
                index.files[fileId] = { id: fileId, folder: folder };
                this.saveFileIndex(domain, index);

                res.json(metadata);
            } catch (error) {
                console.error('[Files] Upload error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Download file from storage
        apiRouter.get('/file/:id/download', async (req, res) => {
            try {
                const { id } = req.params;
                const domain = req.hostname || 'localhost';
                const metadata = this.getFile(domain, id);

                if (!metadata) {
                    return res.status(404).json({ error: 'File not found' });
                }

                const storage = await this.getStorage(domain);

                // Read from raw file (not metadata)
                const fileKey = metadata.fileKey || metadata.storageKey; // backward compat
                const fileData = await storage.readFile(fileKey);

                res.setHeader('Content-Type', metadata.mimetype);
                res.setHeader('Content-Disposition', `attachment; filename="${metadata.name}"`);
                res.setHeader('Content-Length', metadata.size);
                res.send(fileData);
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

                if (!req.episteryClient) {
                    return res.status(401).json({ error: 'Not authenticated' });
                }

                const metadata = this.getFile(domain, id);
                if (!metadata) {
                    return res.status(404).json({ error: 'File not found' });
                }

                // Check permissions - only file owner or admins can delete
                const permissions = await this.getPermissions(req);
                const isOwner = metadata.uploadedBy.toLowerCase() === req.episteryClient.address.toLowerCase();

                if (!isOwner && !permissions.admin) {
                    return res.status(403).json({ error: 'Not authorized to delete this file. Only owner or admin can delete.' });
                }

                // Delete from storage (both raw file and metadata)
                const storage = await this.getStorage(domain);
                if (metadata.keyBase) {
                    const fileKey = metadata.fileKey || `${metadata.keyBase}.${metadata.name.split('.').pop()}`;
                    const metaKey = `${metadata.keyBase}._i`;

                    try {
                        await storage.deleteFiles([fileKey, metaKey]);
                        console.log(`[Files] Deleted from storage: ${fileKey}, ${metaKey}`);
                    } catch (error) {
                        console.warn('[Files] Error deleting from storage:', error.message);
                    }
                }

                // Delete local metadata
                this.deleteFile(domain, id);

                // Update index
                const index = this.getFileIndex(domain);
                delete index.files[id];
                this.saveFileIndex(domain, index);

                res.json({ success: true });
            } catch (error) {
                console.error('[Files] Delete error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        router.use('/api', apiRouter);
    }
}
