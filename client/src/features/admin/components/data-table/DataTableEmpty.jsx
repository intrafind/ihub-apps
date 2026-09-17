import AdminEmptyState from '../AdminEmptyState';

function DataTableEmpty({ colSpan, empty }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12">
        <AdminEmptyState
          icon={empty?.icon || 'inbox'}
          title={empty?.title || 'No results'}
          description={empty?.description}
          action={empty?.action}
        />
      </td>
    </tr>
  );
}

export default DataTableEmpty;
