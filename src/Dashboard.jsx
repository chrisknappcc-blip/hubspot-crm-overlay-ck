// ... (rest of the code remains unchanged)

const GoldAccountsMap = ({ goldAccounts, fetchGoldAccounts }) => {
  const [selected, setSelected] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchGoldAccounts();
    setIsRefreshing(false);
  };

  const handleAccountClick = (account) => {
    setSelected(account);
  };

  const renderAccountNode = (account) => {
    const isSelected = selected && selected.id === account.id;
    const hasAllPersonas = account.personaCoverage.length === 22;
    const nodeColor = hasAllPersonas ? 'green' : 'red';

    return (
      <div
        key={account.id}
        className={`account-node ${isSelected ? 'selected' : ''}`}
        style={{ backgroundColor: nodeColor }}
        onClick={() => handleAccountClick(account)}
      >
        {account.name}
      </div>
    );
  };

  return (
    <div className="gold-accounts-map">
      <button onClick={handleRefresh} disabled={isRefreshing}>
        {isRefreshing ? 'Refreshing...' : 'Refresh'}
      </button>
      <div className="account-nodes">
        {goldAccounts.map(renderAccountNode)}
      </div>
      {selected && (
        <GoldAccountDetails account={selected} />
      )}
    </div>
  );
};

const mapStateToProps = (state) => ({
  goldAccounts: state.goldAccounts,
});

const mapDispatchToProps = {
  fetchGoldAccounts,
};

export default connect(mapStateToProps, mapDispatchToProps)(GoldAccountsMap);

// ... (rest of the code remains unchanged)
