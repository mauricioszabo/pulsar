SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: hstore; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public;


--
-- Name: account_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_status AS ENUM (
    'pending',
    'completed'
);


--
-- Name: api_authorization_scopes; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.api_authorization_scopes AS ENUM (
    'read',
    'write',
    'etl',
    'optimizer',
    'swagger',
    'skie_assist',
    'patching',
    'zee_assist'
);


--
-- Name: audit_operation; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audit_operation AS ENUM (
    'insert',
    'update',
    'delete'
);


--
-- Name: autoscaled_mode_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.autoscaled_mode_enum AS ENUM (
    'no',
    'cas',
    'karpenter',
    'eks_auto_mode'
);
