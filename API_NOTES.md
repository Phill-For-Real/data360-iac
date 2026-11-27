# Data 360 API compatibility

This plugin uses the Salesforce Connect REST API under `/ssot/`. Use the Salesforce
documentation for your API version and the command help for the supported manifest
properties. Availability and behavior depend on the target org's features and
permissions. Fake-client tests verify the plugin's behavior without credentials;
they do not establish compatibility with every Salesforce deployment.

## Connections and ingestion

- Connection lookup requires a connector type. The example ingestion connections
  use `IngestApi`. CRM connector configuration may require an `organizationId`;
  supply it privately rather than committing a real org identifier.
- APIs can normalize submitted names. The plugin tracks the returned identity.
- Data stream creation uses ingestion schema configuration and the stream request.
  Member requests use the returned record identity rather than assuming all IDs in
  a collection response are interchangeable.
- DLO field API names generally have a `__c` suffix. Use the API name when mapping
  fields or assigning governance tags.
- Collection results may be paginated or scoped. Missing collection entries do
  not establish that a resource is absent. Scaffold reports incomplete inventories
  and preserves external dependencies as read-only declarations by default.

## Intelligence, segmentation, and activation

- Calculated insight API names may receive a `__cio` suffix. Stored expressions
  may be HTML-escaped. The adapter normalizes these representations for comparison.
- Identity resolution publication and matching are distinct lifecycle operations.
  A publishing ruleset can have a pending checkpoint; retries require recorded
  evidence before another write or action dispatch.
- A segment member response can wrap its payload in a `segments` array. Status
  polling reads the member payload.
- The activation examples use SQL-backed `Dbt` segments. UI-authored segment types
  may be unavailable to API callers. Other creatable segment types can have
  different activation restrictions.
- Activation configuration includes `dataSpaceName`. Creation and definition
  updates may trigger processing automatically; an extra refresh is not assumed
  to be necessary.

## Governance and deletion

- Tags, classifications, and permission sets must exist before assigning or
  granting them. Examples use public standard object and taxonomy names; replace
  them only with values appropriate for your environment.
- Access policy rule writes use the parent policy's PUT rule endpoint. Rules do
  not have a supported standalone delete endpoint. The plugin requires reviewed
  cascade scope before allowing a parent deletion that removes rules.
- Rule configuration includes `ruleConsumer`. Valid category, effect, scope, and
  consumer combinations depend on the API and its enforcement support.
- The access rule example forbids access to a record. Record-level access control
  and field masking have different effects; validate the intended behavior in
  your target environment.
- Remote deletion can return before dependent resources are released. Recovery
  uses recorded operations and absence evidence; a timeout does not prove that a
  write failed.

## Private runtime data

Authentication, discovery snapshots, state, operation journals, plans, and scaffold
reports can contain private org configuration. Keep them outside public source
trees. Use `$secret` references for credentials, review generated output before
sharing it, and run the release checks described in [RELEASING.md](RELEASING.md).
