#!/bin/bash
set -e

# Create enterprise user and database (synapse_db is already the default POSTGRES_DB)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER enterprise_user WITH PASSWORD 'enterprise_pass';
    CREATE DATABASE enterprise_db OWNER enterprise_user;
EOSQL
