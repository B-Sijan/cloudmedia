const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { Connection, Request, TYPES } = require('tedious');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function validateEnv() {
    const required = [
        'SQL_SERVER',
        'SQL_DATABASE',
        'SQL_USERNAME',
        'SQL_PASSWORD',
        'BLOB_CONNECTION_STRING',
        'BLOB_CONTAINER_NAME'
    ];

    const missing = required.filter((name) => !process.env[name]);

    if (missing.length > 0) {
        throw new Error(`Missing environment variables: ${missing.join(', ')}`);
    }
}

function getSqlConfig() {
    return {
        server: process.env.SQL_SERVER,
        authentication: {
            type: 'default',
            options: {
                userName: process.env.SQL_USERNAME,
                password: process.env.SQL_PASSWORD
            }
        },
        options: {
            database: process.env.SQL_DATABASE,
            encrypt: true,
            trustServerCertificate: false,
            port: 1433,
            connectTimeout: 30000,
            requestTimeout: 30000
        }
    };
}

function executeSql(sql, parameters = []) {
    return new Promise((resolve, reject) => {
        const connection = new Connection(getSqlConfig());
        const rows = [];
        let completed = false;

        function finish(err, result) {
            if (completed) return;
            completed = true;

            try {
                connection.close();
            } catch (_) {}

            if (err) reject(err);
            else resolve(result);
        }

        connection.on('connect', (err) => {
            if (err) {
                return finish(new Error(`SQL connection failed: ${err.message}`));
            }

            const request = new Request(sql, (err) => {
                if (err) {
                    return finish(new Error(`SQL query failed: ${err.message}`));
                }

                finish(null, rows);
            });

            for (const param of parameters) {
                request.addParameter(param.name, param.type, param.value);
            }

            request.on('row', (columns) => {
                const row = {};

                columns.forEach((column) => {
                    row[column.metadata.colName] = column.value;
                });

                rows.push(row);
            });

            connection.execSql(request);
        });

        connection.on('error', (err) => {
            finish(new Error(`SQL runtime error: ${err.message}`));
        });

        connection.connect();
    });
}

function sanitizeFileName(fileName) {
    return fileName
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

async function getValidUserId(inputUserId) {
    if (inputUserId) {
        const existingUser = await executeSql(
            'SELECT TOP 1 UserId FROM Users WHERE UserId = @UserId',
            [
                {
                    name: 'UserId',
                    type: TYPES.Int,
                    value: inputUserId
                }
            ]
        );

        if (existingUser.length > 0) {
            return inputUserId;
        }
    }

    const firstUser = await executeSql(
        'SELECT TOP 1 UserId FROM Users ORDER BY UserId ASC'
    );

    if (firstUser.length > 0) {
        return firstUser[0].UserId;
    }

    throw new Error(
        'No user exists in the Users table. Create a user first before uploading media.'
    );
}

async function uploadToBlob(file, context) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
        process.env.BLOB_CONNECTION_STRING
    );

    const containerName = process.env.BLOB_CONTAINER_NAME.toLowerCase();
    const containerClient = blobServiceClient.getContainerClient(containerName);

    await containerClient.createIfNotExists({
        access: 'blob'
    });

    const originalFileName = file.name || 'upload-file';
    const safeFileName = sanitizeFileName(originalFileName);
    const blobName = `${Date.now()}-${safeFileName}`;

    context.log('Uploading blob:', blobName);

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const mediaType = file.type || 'application/octet-stream';

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(fileBuffer, {
        blobHTTPHeaders: {
            blobContentType: mediaType
        }
    });

    return {
        blobUrl: blockBlobClient.url,
        mediaType
    };
}

async function saveAssetToSql({ userId, title, description, mediaType, blobUrl }) {
    const sql = `
        INSERT INTO Assets
        (
            UserId,
            Title,
            Description,
            MediaType,
            BlobUrl,
            Visibility
        )
        VALUES
        (
            @UserId,
            @Title,
            @Description,
            @MediaType,
            @BlobUrl,
            @Visibility
        );
    `;

    await executeSql(sql, [
        {
            name: 'UserId',
            type: TYPES.Int,
            value: userId
        },
        {
            name: 'Title',
            type: TYPES.NVarChar,
            value: title
        },
        {
            name: 'Description',
            type: TYPES.NVarChar,
            value: description
        },
        {
            name: 'MediaType',
            type: TYPES.NVarChar,
            value: mediaType
        },
        {
            name: 'BlobUrl',
            type: TYPES.NVarChar,
            value: blobUrl
        },
        {
            name: 'Visibility',
            type: TYPES.NVarChar,
            value: 'public'
        }
    ]);
}

app.http('uploadAsset', {
    methods: ['OPTIONS', 'POST'],
    authLevel: 'anonymous',

    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return {
                status: 204,
                headers: corsHeaders
            };
        }

        try {
            validateEnv();

            const formData = await request.formData();

            const title = String(formData.get('title') || 'Untitled').trim();
            const description = String(formData.get('description') || '').trim();
            const file = formData.get('file');

            const rawUserId = Number.parseInt(formData.get('userId'), 10);
            const userId = await getValidUserId(Number.isNaN(rawUserId) ? null : rawUserId);

            if (!file) {
                return {
                    status: 400,
                    headers: corsHeaders,
                    jsonBody: {
                        success: false,
                        error: 'No file uploaded'
                    }
                };
            }

            const { blobUrl, mediaType } = await uploadToBlob(file, context);

            await saveAssetToSql({
                userId,
                title,
                description,
                mediaType,
                blobUrl
            });

            return {
                status: 200,
                headers: corsHeaders,
                jsonBody: {
                    success: true,
                    message: 'Upload successful',
                    userId,
                    blobUrl
                }
            };
        } catch (err) {
            context.log('UPLOAD ERROR:', err.message);

            return {
                status: 500,
                headers: corsHeaders,
                jsonBody: {
                    success: false,
                    error: err.message
                }
            };
        }
    }
});

app.http('getAssets', {
    methods: ['OPTIONS', 'GET'],
    authLevel: 'anonymous',

    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return {
                status: 204,
                headers: corsHeaders
            };
        }

        try {
            validateEnv();

            const assets = await executeSql(`
                SELECT
                    AssetId,
                    UserId,
                    Title,
                    Description,
                    MediaType,
                    BlobUrl,
                    ThumbnailUrl,
                    UploadedAt,
                    Visibility
                FROM Assets
                ORDER BY UploadedAt DESC;
            `);

            return {
                status: 200,
                headers: corsHeaders,
                jsonBody: {
                    success: true,
                    assets
                }
            };
        } catch (err) {
            context.log('GET ASSETS ERROR:', err.message);

            return {
                status: 500,
                headers: corsHeaders,
                jsonBody: {
                    success: false,
                    error: err.message
                }
            };
        }
    }
});