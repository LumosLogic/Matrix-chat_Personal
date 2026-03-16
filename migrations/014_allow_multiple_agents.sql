-- Migration 014: Allow multiple Agents (Trusted Users) per company
-- Previously a unique partial index enforced only one active agent per company.
-- This removes that restriction so admins can assign agent role to any number of users.

DROP INDEX IF EXISTS one_trusted_user_per_company;
