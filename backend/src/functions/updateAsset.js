const { app } = require('@azure/functions');
const { Connection, Request, TYPES } = require('tedious');

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
            trustServerCertificate: false
        }
    };
}

app.http('updateAsset', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'updateAsset/{id}',
    handler: async (request, context) => {
        context.log('Update asset function triggered');

        try {
            const id = parseInt(request.params.id);
            if (!id) {
                return { status: 400, body: 'Asset ID is required' };
            }

            const body = await request.json();
            const { title, description, visibility } = body;

            if (!title) {
                return { status: 400, body: 'Title is required' };
            }

            await updateInSql({ id, title, description, visibility });

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'Asset updated successfully' })
            };

        } catch (err) {
            context.log('Error:', err);
            return { status: 500, body: `Error: ${err.message}` };
        }
    }
});

function updateInSql({ id, title, description, visibility }) {
    return new Promise((resolve, reject) => {
        const connection = new Connection(getSqlConfig());

        connection.on('connect', err => {
            if (err) return reject(err);

            const sql = `UPDATE Assets 
                         SET Title = @Title, 
                             Description = @Description,
                             Visibility = @Visibility
                         WHERE AssetId = @Id`;

            const req = new Request(sql, (err) => {
                connection.close();
                if (err) reject(err);
                else resolve();
            });

            req.addParameter('Title', TYPES.VarChar, title);
            req.addParameter('Description', TYPES.VarChar, description || '');
            req.addParameter('Visibility', TYPES.VarChar, visibility || 'public');
            req.addParameter('Id', TYPES.Int, id);

            connection.execSql(req);
        });

        connection.connect();
    });
}