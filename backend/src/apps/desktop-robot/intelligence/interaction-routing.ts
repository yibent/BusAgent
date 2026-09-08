import type { Action, Goal, QueueState } from './types.js';

// These are optional shortcuts. Anything not fully matched still reaches the planner.
const compact = (text: string) => text.replace(/[\s，。！？、,.!?]/g, '').toLowerCase();
export const hasMeaningfulInput = (text: string) => /[\p{L}\p{N}]/u.test(text);
export const isAcknowledgement = (text: string) => {
  const input = compact(text).replace(
    /^(?:嗯|呃|啊|哦|噢|唔|喂)+|(?:嗯|呃|啊|哦|噢|唔|喂)+$/g,
    '',
  );
  return (
    !input ||
    /^(?:好+的?|收到|知道了|明白了|谢谢|对+的?|是+的?|行|可以|可以(?:做|执行)(?:这个|它|刚才的?|上面的?)|没问题|就这样|按这个来|开始吧)$/.test(
      input,
    )
  );
};
const command = (text: string) =>
  compact(text)
    .replace(/^(?:(?:嗯|呃|好的|好|那|你|请|帮我|麻烦|先|把))*/, '')
    .replace(/(?:一下|吧|一下吧)$/, '');

export function immediateAction(text: string): Action | undefined {
  const input = command(text);
  if (
    /^(?:(?:机械臂|机器人)(?:先)?)?(?:复位|归位|回零|回到初始位置|回到初始姿态|home)$/.test(
      input,
    )
  )
    return { title: '机械臂复位', skill: 'home', params: {}, review_after: false };
  if (/^(?:(?:夹爪|爪子)(?:张开|打开)|(?:张开|打开)(?:夹爪|爪子))$/.test(input))
    return {
      title: '张开夹爪',
      skill: 'gripper',
      params: { opening: 1 },
      review_after: false,
    };
  if (/^(?:(?:夹爪|爪子)(?:闭合|关闭)|(?:闭合|关闭)(?:夹爪|爪子))$/.test(input))
    return {
      title: '闭合夹爪',
      skill: 'gripper',
      params: { opening: 0 },
      review_after: false,
    };
  return undefined;
}

export function isSceneQuestion(text: string): boolean {
  const input = compact(text).replace(/^(?:(?:嗯|呃|请|你|帮我))*/, '');
  return (
    /^(?:当前|现在|目前)?(?:可以|能)?(?:看到|看见)(?:些什么|什么|哪些)(?:东西|物体|物品|零件)?(?:吗|呢)?$/.test(
      input,
    ) ||
    /^(?:能|可以)?(?:看到|看见|看看|描述|说说)?(?:当前|现在)?(?:的)?(?:桌面|桌子|场景|画面)(?:上|里|中)?(?:都)?(?:(?:可以|能)?(?:看到|看见)|有)?(?:些什么|什么|哪些)(?:东西|物体|物品|零件)?(?:吗|呢)?$/.test(
      input,
    ) ||
    /^(?:看看|描述|说说)(?:一下)?(?:当前|现在)?(?:的)?(?:桌面|场景|画面)(?:布局|情况)?$/.test(
      input,
    )
  );
}

export const executionGoals = (state: QueueState) =>
  state.goals.filter(
    (g) =>
      g.steps.length > 0 ||
      (g.interaction !== true &&
        ['queued', 'planning', 'running', 'review'].includes(g.state)),
  );

export function relevantGoals(state: QueueState, conversation?: string): Goal[] {
  const rank = (g: Goal) =>
    [
      'running',
      'review',
      'queued',
      'planning',
      'paused',
      'blocked',
      'completed',
      'cancelled',
    ].indexOf(g.state);
  return executionGoals(state).toSorted(
    (a, b) =>
      Number(b.conversation_id === conversation) -
        Number(a.conversation_id === conversation) ||
      rank(a) - rank(b) ||
      b.created_at.localeCompare(a.created_at),
  );
}

/** Other sessions' dormant tasks are retrievable history, not current instructions. */
export const contextualGoals = (state: QueueState, conversation: string) =>
  relevantGoals(state, conversation).filter(
    (g) =>
      g.conversation_id === conversation ||
      ['running', 'review', 'planning', 'queued'].includes(g.state),
  );

export function waitingMessage(state: QueueState, goal: Goal): string {
  const title =
    goal.steps
      .filter((s) => s.state === 'pending')
      .map((s) => s.title)
      .join('；') || goal.summary;
  if (state.paused) return `${title}尚未开始：执行队列已暂停。恢复队列后才会执行。`;
  const ahead = executionGoals(state).find(
    (g) =>
      g.id !== goal.id &&
      state.goals.indexOf(g) < state.goals.indexOf(goal) &&
      ['running', 'queued', 'planning', 'review'].includes(g.state),
  );
  return ahead
    ? `${title}将等待“${ahead.summary || ahead.source}”结束后执行。`
    : `准备执行${title}。`;
}

export function statusReply(
  state: QueueState,
  text: string,
  conversation: string,
): { text: string; goal?: Goal } | undefined {
  const input = compact(text).replace(/^(?:(?:嗯|呃|啊))*/, '');
  const currentQuestion =
    /^(?:请问|请|帮我看看)?(?:你|你们|系统|机械臂|机器人)?(?:现在|当前|目前)?(?:正在|在)?(?:干啥|干什么|做啥|做什么|忙什么|忙啥|执行什么|执行哪个任务)(?:呢|呀|啊|吗)?$/.test(
      input,
    );
  const queueQuestion =
    /^(?:请问|帮我看看|看看)?(?:我|我们|你)?(?:现在|当前)?(?:的)?(?:后面|后续|接下来|剩下|剩余|待执行|队列里|队列中)(?:的)?(?:任务|动作|安排)(?:呢|有哪些|是什么|是什么情况)?$/.test(
      input,
    );
  if (queueQuestion) {
    const goals = state.goals.filter(
      (g) =>
        ['queued', 'planning', 'running', 'review', 'paused'].includes(g.state) &&
        (g.conversation_id === conversation || !g.interaction || g.steps.length > 0),
    );
    const descriptions = goals.map((g) => {
      const running = g.steps.find((s) =>
        ['running', 'dispatching', 'unknown'].includes(s.state),
      );
      return `${g.summary || g.source}：${running ? `正在执行“${running.title}”` : g.state === 'planning' ? '正在规划' : state.paused || g.state === 'paused' ? '已暂停' : '等待执行'}`;
    });
    return {
      text: descriptions.length
        ? descriptions.join('；') + '。'
        : '当前没有待执行的任务。',
    };
  }
  const followup = /^(?:还没|还没有|已经|现在)(?:看到|看清|看完)(?:了)?吗$/.test(input);
  const named =
    /^(?:请问|帮我查一下|查一下)?(.+?)(?:任务|动作)?(?:执行[得的]?)?(?:怎么样了|怎样了|到哪了|完成了吗|结束了吗|执行了吗|开始了吗|的进度|的状态)$/.exec(
      input,
    );
  const subject = named?.[1]?.replace(/(?:的)?(?:任务|动作)$/, '');
  const status =
    currentQuestion ||
    /^(?:请问|请|帮我|查一下|看看)?(?:当前|现在)?(?:的)?(?:状态|进度|正在做什么|在做什么|做到哪了|还剩什么)$/.test(
      input,
    ) ||
    /^(?:还没|还没有|已经|现在)?(?:得到结果|出结果|有结果|完成|做完|执行完)(?:了)?(?:吗|么|没有|没)$/.test(
      input,
    ) ||
    /^(?:(?:机械臂|机器人)?(?:复位|归位|回零)(?:任务|动作)?|(?:刚才|这个|那个|当前|上一[个项步])(?:的)?(?:任务|动作)?)(?:执行[得的]?)?(?:怎么样了|怎样了|到哪了|完成了吗|结束了吗|执行了吗|开始了吗|进度|状态)$/.test(
      input,
    );
  if (!status && !followup && !named) return undefined;
  const goals = contextualGoals(state, conversation);
  // Intake interpretation is also real work, even before it has produced actions.
  const intake = state.goals.find(
    (g) =>
      g.conversation_id === conversation &&
      g.interaction &&
      ['queued', 'planning'].includes(g.state),
  );
  const goal = followup
    ? state.goals.findLast(
        (g) => g.conversation_id === conversation && isSceneQuestion(g.source),
      )
    : /复位|归位|回零/.test(input)
      ? goals.find((g) => g.steps.some((s) => s.skill === 'home'))
      : !status && subject
        ? goals.find((g) =>
            [g.source, g.summary, ...g.steps.map((s) => s.title)].some((value) =>
              compact(value).includes(subject),
            ),
          )
        : (goals.find((g) => !['completed', 'cancelled'].includes(g.state)) ??
          intake ??
          goals[0]);
  // Unknown paraphrases remain model-resolvable; never substitute an unrelated task.
  if (!goal && !status && named) return undefined;
  if (!goal)
    return {
      text: state.paused
        ? '执行队列已暂停，当前没有这项动作的执行记录。'
        : '当前没有这项动作的执行记录。',
    };
  if (followup)
    return {
      goal,
      text:
        goal.state === 'completed'
          ? goal.message
          : goal.state === 'blocked'
            ? `刚才的观察没有完成：${goal.message}`
            : '还在分析刚才的画面，结果尚未返回。',
    };
  const done = goal.steps.filter((s) => s.state === 'completed').length;
  const running = goal.steps.find((s) =>
    ['running', 'dispatching', 'unknown'].includes(s.state),
  );
  let message: string;
  if (running)
    message =
      running.state === 'unknown'
        ? `“${running.title}”的执行结果尚未确认，正在核对。`
        : `“${running.title}”${running.state === 'dispatching' ? '正在下发，尚未确认完成' : '正在执行，尚未完成'}。`;
  else if (goal.steps.length && done === goal.steps.length)
    message = `“${goal.summary || goal.source}”的 ${done} 个动作已收到完成记录。`;
  else if (goal.state === 'cancelled')
    message = `“${goal.summary || goal.source}”已取消，已完成 ${done}/${goal.steps.length} 步。`;
  else if (state.paused || goal.state === 'paused')
    message = `“${goal.summary || goal.source}”${done ? `已完成 ${done}/${goal.steps.length} 步，剩余步骤` : '尚未开始，'}因${state.paused ? '执行队列' : '任务'}暂停而等待。`;
  else if (goal.state === 'blocked')
    message = `“${goal.summary || goal.source}”需要处理：${goal.message}`;
  else
    message = `“${goal.summary || goal.source}”${goal.state === 'planning' ? '仍在规划' : '等待执行'}，尚未完成。`;
  return { text: message, goal };
}
