const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { Connection, Request, TYPES } = require('tedious');

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

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

function getBlobNameFromUrl(blobUrl) {
    const url = new URL(blobUrl);
    const parts = url.pathname.split('/');

    return decodeURIComponent(parts.slice(2).join('/'));
}

function getBlobUrl(id) {
    return new Promise((resolve, reject) => {
        const connection = new Connection(getSqlConfig());
        let blobUrl = null;
        let finished = false;

        function done(err, value) {
            if (finished) return;
            finished = true;

            try {
                connection.close();
            } catch (_) {}

            if (err) reject(err);
            else resolve(value);
        }

        connection.on('connect', (err) => {
            if (err) {
                return done(err);
            }

            const sql = `
                SELECT TOP 1 BlobUrl
                FROM Assets
                WHERE AssetId = @Id;
            `;

            const req = new Request(sql, (err) => {
                if (err) {
                    return done(err);
                }

                done(null, blobUrl);
            });

            req.addParameter('Id', TYPES.Int, id);

            req.on('row', (columns) => {
                blobUrl = columns[0].value;
            });

            connection.execSql(req);
        });

        connection.on('error', (err) => {
            done(err);
        });

        connection.connect();
    });
}

function deleteFromSql(id) {
    return new Promise((resolve, reject) => {
        const connection = new Connection(getSqlConfig());
        let finished = false;

        function done(err) {
            if (finished) return;
            finished = true;

            try {
                connection.close();
            } catch (_) {}

            if (err) reject(err);
            else resolve();
        }

        connection.on('connect', (err) => {
            if (err) {
                return done(err);
            }

            const sql = `
                DELETE FROM Assets
                WHERE AssetId = @Id;
            `;

            const req = new Request(sql, (err) => {
                if (err) {
                    return done(err);
                }

                done();
            });

            req.addParameter('Id', TYPES.Int, id);
            connection.execSql(req);
        });

        connection.on('error', (err) => {
            done(err);
        });

        connection.connect();
    });
}

app.http('deleteAsset', {
    methods: ['OPTIONS', 'DELETE'],
    authLevel: 'anonymous',
    route: 'deleteAsset/{id}',

    handler: async (request, context) => {
        if (request.method === 'OPTIONS') {
            return {
                status: 204,
                headers: corsHeaders
            };
        }

        context.log('Delete asset function triggered');

        try {
            const id = Number.parseInt(request.params.id, 10);

            if (!id) {
                return {
                    status: 400,
                    headers: corsHeaders,
                    jsonBody: {
                        success: false,
                        error: 'Asset ID is required'
                    }
                };
            }

            const blobUrl = await getBlobUrl(id);

            if (!blobUrl) {
                return {
                    status: 404,
                    headers: corsHeaders,
                    jsonBody: {
                        success: false,
                        error: 'Asset not found'
                    }
                };
            }

            const blobServiceClient = BlobServiceClient.fromConnectionString(
                process.env.BLOB_CONNECTION_STRING
            );

            const containerClient = blobServiceClient.getContainerClient(
                process.env.BLOB_CONTAINER_NAME.toLowerCase()
            );

            const blobName = getBlobNameFromUrl(blobUrl);

            context.log('Deleting blob:', blobName);

            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            await blockBlobClient.deleteIfExists();

            await deleteFromSql(id);

            return {
                status: 200,
                headers: corsHeaders,
                jsonBody: {
                    success: true,
                    message: 'Asset deleted successfully'
                }
            };

        } catch (err) {
            context.log('DELETE ERROR:', err.message);

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