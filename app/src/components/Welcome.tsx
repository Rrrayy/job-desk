/** 首次打开的欢迎层：两个入口，绝不自动灌示例数据。 */

export interface WelcomeProps {
  onLoadSample: () => void;
  onStart: () => void;
}

export function Welcome({ onLoadSample, onStart }: WelcomeProps) {
  return (
    <div className="overlay overlay--welcome">
      <div className="welcome">
        <div className="welcome__mark">职</div>
        <h1 className="welcome__title">求职工作台</h1>
        <p className="welcome__lead">
          一家公司 = 一条管线。
          <br />
          BOSS 上聊过的第一个人，值得被记住。
        </p>
        <ul className="welcome__list">
          <li>投完就记，两个字段就够，回车即保存</li>
          <li>3 天没动静会变黄，7 天会变红 —— 不用你算天数</li>
          <li>面试撞课会提醒你，撞期也提醒你</li>
        </ul>
        <div className="welcome__actions">
          <button type="button" className="btn btn--primary btn--lg" onClick={onLoadSample}>
            加载示例数据看看
          </button>
          <button type="button" className="btn btn--lg" onClick={onStart}>
            我要自己记第一家
          </button>
        </div>
        <p className="welcome__foot">数据只存在这台电脑的浏览器里，随时可导出备份。</p>
      </div>
    </div>
  );
}
