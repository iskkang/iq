/**
 * 참조 데이터 조회 실패를 두 갈래로 구분한다.
 *
 * 하나로 뭉치면 **전체 장애가 "사용자 입력 문제"로 나가거나 그 반대**가 된다.
 * 원장이 통째로 비어 duty 가 전부 0 이 되는 사고를 "기준일을 확인하세요" 로
 * 안내하면 아무도 고치지 못한다.
 *
 *   config    참조 테이블이 비어 있다 → 배포·설정 실패. 운영자가 고쳐야 한다
 *   coverage  행은 있으나 그 기준일을 덮는 게 없다 → 사용자 입력 문제.
 *             예: 2020년으로 조회했는데 원장이 2024년부터 시작한다
 */
export type ReferenceDataErrorKind = 'config' | 'coverage'

export class ReferenceDataError extends Error {
  readonly kind: ReferenceDataErrorKind
  readonly table: string

  constructor(kind: ReferenceDataErrorKind, table: string, message: string) {
    super(message)
    this.name = 'ReferenceDataError'
    this.kind = kind
    this.table = table
  }

  /** 참조 테이블이 비어 있다 — 배포·설정 실패 */
  static config(table: string): ReferenceDataError {
    return new ReferenceDataError(
      'config',
      table,
      `Rate data is not available right now (${table} is empty). ` +
        `This is a configuration problem on our side, not something you did — ` +
        `please contact support@landediq.app.`,
    )
  }

  /** 기준일을 덮는 행이 없다 — 사용자 입력 문제 */
  static coverage(table: string, asOf: string): ReferenceDataError {
    return new ReferenceDataError(
      'coverage',
      table,
      `No rate data covers ${asOf}. Pick a date within the period we have rates for, ` +
        `then run the report again.`,
    )
  }
}
