require('dotenv').config();
const { Pool } = require('pg');

const synapseDbConfig = {
  host: process.env.SYNAPSE_DB_HOST || 'localhost',
  port: parseInt(process.env.SYNAPSE_DB_PORT, 10) || 5433,
  database: process.env.SYNAPSE_DB_NAME || 'synapse_db',
  user: process.env.SYNAPSE_DB_USER || 'synapse_user',
  password: process.env.SYNAPSE_DB_PASSWORD || 'synapse_pass',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

console.log('Synapse DB Config:', {
  host: synapseDbConfig.host,
  port: synapseDbConfig.port,
  database: synapseDbConfig.database,
  user: synapseDbConfig.user,
  password: synapseDbConfig.password ? '***' : 'NOT SET',
});

const synapsePool = new Pool(synapseDbConfig);

synapsePool.on('error', (err) => {
  console.error('Unexpected Synapse PostgreSQL pool error:', err);
});

module.exports = synapsePool;
