#!/usr/bin/env bash
set -e

# Update pg_hba.conf to trust all connections for disposable testing
PG_HBA=$(find /etc/postgresql/ -name pg_hba.conf | head -n 1)
sed -i 's/^host.*scram-sha-256/host all all all trust/' "$PG_HBA"
echo "host all all all trust" >> "$PG_HBA"
echo "host all all 0.0.0.0/0 trust" >> "$PG_HBA"
echo "host all all 127.0.0.1/32 trust" >> "$PG_HBA"
echo "host all all ::1/128 trust" >> "$PG_HBA"

# Update postgresql.conf to listen on all addresses
PG_CONF=$(find /etc/postgresql/ -name postgresql.conf | head -n 1)
echo "listen_addresses = '*'" >> "$PG_CONF"

service postgresql restart

# Set password and create test database
su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'testpassword';\""
su - postgres -c "psql -c \"CREATE DATABASE hackmate_test;\" || true"

echo "PostgreSQL configured successfully for hackmate_test!"
