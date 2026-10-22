/** Production and staging must not publish Swagger discovery or UI. */
export function shouldExposeSwagger(environment: string | undefined): boolean {
  return environment !== 'production' && environment !== 'staging';
}
