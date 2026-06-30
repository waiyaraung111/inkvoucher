// Demo build wrapper. Sets APP_ENV so the version badge reads
// "Demo / Testing", then runs the same build.js pipeline.
// Invoked via: npm run build:demo  (or as part of npm run deploy:demo)
process.env.APP_ENV = 'Demo / Testing';
require('./build.js');
