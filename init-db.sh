#!/bin/bash
set -e

# Create the enterprise database and user
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE USER enterprise_user WITH PASSWORD 'enterprise_pass';
    CREATE DATABASE enterprise_db OWNER enterprise_user;
EOSQL
