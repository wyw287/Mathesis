/**
 * nerdamer 没有类型声明,这里给它一个最小的形状。
 *
 * 只声明我们实际用到的部分 —— 声明得越窄,以后误用它的其他 API 时越容易发现。
 */
declare module 'nerdamer/all.min.js' {
  interface CasExpression {
    toString(): string;
  }

  interface Nerdamer {
    (expression: string): CasExpression;
    diff(expression: string, variable: string): CasExpression;
    integrate(expression: string, variable: string): CasExpression;
  }

  const nerdamer: Nerdamer;
  export default nerdamer;
}
