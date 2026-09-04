import { Link } from "react-router-dom";
import { ArrowIcon, MessageIcon, RobotIcon } from "../components/Icons";

const apps = [
  {
    id: "robot",
    name: "机器人操作台",
    description: "通过语音控制 SO-101，并实时查看多节点协作与并行任务路径。",
    path: "/apps/robot",
    icon: "robot",
  },
  {
    id: "dialogue",
    name: "机械臂操作助手",
    description: "通过文字或语音下达工程操作指令并查询执行状态。",
    path: "/apps/dialogue",
    icon: "message",
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
              {app.icon === "robot" ? <RobotIcon /> : <MessageIcon />}
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
