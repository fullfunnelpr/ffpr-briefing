// The four Notion task boards the briefing reads (READ-ONLY).
// - dataSourceId  → primary query endpoint  POST /v1/data_sources/{id}/query  (Notion-Version 2025-09-03)
// - databaseId    → fallback query endpoint POST /v1/databases/{id}/query     (Notion-Version 2022-06-28)
// clientOrInternal drives the "client work outranks internal" ranking rule.
// To add a client: append a board here (and redeploy). To offboard: remove it.
export default [
  {
    key: 'ffpr',
    label: 'Full Funnel PR',
    clientOrInternal: 'internal',
    dataSourceId: 'ea287192-3942-47c6-bb4a-8f344bafcc9c',
    databaseId: '9b632bf3-0547-4d41-b431-1a602ea93102',
  },
  {
    key: 'axate',
    label: 'Axate',
    clientOrInternal: 'client',
    dataSourceId: 'af6fc7e2-4961-436e-b9ea-f5e77cc41529',
    databaseId: '2a05251f-072f-49f3-a67e-a9c85142e7ee',
  },
  {
    key: 'doubleverify',
    label: 'DoubleVerify / ModOp',
    clientOrInternal: 'client',
    dataSourceId: '7ce6aff2-bbb3-4868-8330-7d49dd738cf7',
    databaseId: '4d239445-6c3b-4ca6-8af3-8dffe1234883',
  },
  {
    key: 'ogp',
    label: 'Oxford Global Projects',
    clientOrInternal: 'client',
    dataSourceId: '141b1c67-4378-4341-be9a-f54d8d8a57f5',
    databaseId: '18a2a1fd-5e62-4af2-8baa-3334c1baa48c',
  },
];
