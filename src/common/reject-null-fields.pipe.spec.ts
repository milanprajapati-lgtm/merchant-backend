import { BadRequestException } from '@nestjs/common';
import { RejectNullFieldsPipe } from './reject-null-fields.pipe';

describe('RejectNullFieldsPipe', () => {
  const pipe = new RejectNullFieldsPipe();

  it('passes through bodies with no nulls, including omitted fields', () => {
    const body = { businessName: 'Acme' };
    expect(pipe.transform(body)).toBe(body);
    expect(pipe.transform({})).toEqual({});
  });

  it('rejects null values and names the offending fields', () => {
    expect(() => pipe.transform({ businessName: null, ownerName: null, contactEmail: 'a@b.test' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ businessName: null, ownerName: null })).toThrow(/businessName, ownerName must not be null/);
  });

  it('ignores non-object values', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform('x')).toBe('x');
  });
});
