import { describe, expect, it } from 'vitest';
import { sourcePersistenceMatch, validateAnalysisSource } from '../analysis';

describe('analysis source handling', () => {
  it('accepts an issue body source and routes it to the issue', () => {
    expect(validateAnalysisSource('issue-1', 'issueId')).toEqual({
      source: 'issue-1',
      sourceType: 'issueId',
    });
    const query = sourcePersistenceMatch('issueId', 'Solution');
    expect(query).toContain('MATCH (i:Issue {issueId: $source})');
    expect(query).toContain('HAS_SOLUTION');
    expect(query).not.toContain('Comment');
  });

  it('accepts a comment source and links it to the owning issue', () => {
    expect(validateAnalysisSource('comment-1', 'commentId')).toEqual({
      source: 'comment-1',
      sourceType: 'commentId',
    });
    const query = sourcePersistenceMatch('commentId', 'Workaround');
    expect(query).toContain('MATCH (c:Comment {commentId: $source})');
    expect(query).toContain('MATCH (c)<-[:HAS_COMMENT]-(i:Issue)');
    expect(query).toContain('HAS_WORKAROUND');
  });

  it('supports mixed body and comment sources without changing source identity', () => {
    const sources = [
      validateAnalysisSource('issue-1', 'issueId'),
      validateAnalysisSource('comment-1', 'commentId'),
    ];
    expect(sources.map((s) => s.sourceType)).toEqual(['issueId', 'commentId']);
    expect(sourcePersistenceMatch(sources[0].sourceType, 'Solution')).toContain('Issue');
    expect(sourcePersistenceMatch(sources[1].sourceType, 'Solution')).toContain('Comment');
  });

  it('leaves empty extraction arrays representable without inventing a source', () => {
    const solutions: { source?: string; sourceType?: string }[] = [];
    expect(solutions).toHaveLength(0);
    expect(() => validateAnalysisSource('', 'issueId')).toThrow('non-empty');
  });

  it('rejects malformed source metadata instead of silently writing it', () => {
    expect(() => validateAnalysisSource('comment-1', undefined)).toThrow('sourceType');
    expect(() => validateAnalysisSource(null, 'commentId')).toThrow('non-empty');
    expect(() => validateAnalysisSource('issue-1', 'CommentId')).toThrow('sourceType');
  });

  it('keeps duplicate source writes idempotent through MERGE', () => {
    const query = sourcePersistenceMatch('commentId', 'Solution');
    expect(query.match(/MERGE \(c\)-\[:HAS_SOLUTION\]->\(s\)/g)).toHaveLength(1);
  });

});