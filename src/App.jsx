import Card from './Card';

function App() {
  return (
    <div
      className="app-shell"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'end',
        justifyContent: 'center',
        background: '#e8dcc6',
        padding: '24px 20px',
      }}
    >
      <Card />
    </div>
  );
}

export default App;
