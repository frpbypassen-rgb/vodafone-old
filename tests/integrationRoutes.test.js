const fs = require('fs');
const path = require('path');

describe('Integration API routing', () => {
    test('mounts clientApi before the 404 handler and after existing API routes', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        const integrationMount = appSource.indexOf("app.use('/api', require('./routes/api/clientApi'))");
        const mobileMount = appSource.indexOf("app.use('/api/mobile', require('./routes/mobileApi'))");
        const merchantRoute = appSource.indexOf("app.get('/api/v1/merchant/status/:reference_id'");
        const notFoundHandler = appSource.indexOf('app.use(notFoundHandler)');

        expect(integrationMount).toBeGreaterThan(mobileMount);
        expect(integrationMount).toBeGreaterThan(merchantRoute);
        expect(integrationMount).toBeLessThan(notFoundHandler);
    });
});
