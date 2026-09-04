import { Link } from 'react-router-dom';
import { ArrowIcon, MessageIcon } from '../components/Icons';

const apps = [
  {
    id: 'dialogue',
    name: '对话助手',
    description: '通过文字或语音，自然地与 BusAgent 交流。',
    path: '/apps/dialogue',
  },
];

export function HomePage() {
  return (
    <main className="home-shell">
      <header className="home-heading">
        <div className="brand-mark" aria-hidden="true">
          B
        </div>
        <p className="eyebrow">BusAgent</p>
        <h1>选择一个 App</h1>
        <p className="home-subtitle">从这里进入你需要的智能应用</p>
      </header>

      <section className="app-grid" aria-label="App 列表">
        {apps.map((app) => (
          <Link className="app-card" to={app.path} key={app.id}>
            <span className="app-icon">
              <MessageIcon />
            </span>
            <span className="app-copy">
              <strong>{app.name}</strong>
              <span>{app.description}</span>
            </span>
            <span className="app-arrow">
              <ArrowIcon />
            </span>
          </Link>
        ))}
      </section>
    </main>
  );
}
