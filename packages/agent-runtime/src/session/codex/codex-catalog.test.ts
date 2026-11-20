import { describe, expect, it } from 'vitest'
import { codexModelListing, codexModelUpgrade, codexPolicy } from './codex-catalog.js'
import { codexBuilders } from './testing/index.js'

const { buildModel, buildPermissionProfiles, buildRequirements } = codexBuilders

describe('codexModelListing', () => {
  it('lists visible models with their efforts, tiers and image input, defaulting as Codex does', () => {
    const listing = codexModelListing([
      buildModel('gpt-6.2-sol', { isDefault: true, defaultReasoningEffort: 'high' }),
      buildModel('secret', { hidden: true }),
      buildModel('gpt-6-luna', { inputModalities: ['text'], serviceTiers: [] }),
    ])

    expect(listing.currentModelId).toBe('gpt-6.2-sol')
    expect(listing.availableModels?.map((model) => model.id)).toEqual(['gpt-6.2-sol', 'gpt-6-luna'])
    const [sol, luna] = listing.availableModels!
    expect(sol).toMatchObject({
      displayName: 'GPT-6.2-SOL',
      effortLevels: ['low', 'high'],
      supportsFastMode: true,
      supportsImageInput: true,
    })
    expect(sol!.configOptions).toEqual([
      {
        type: 'select',
        id: 'effort',
        name: 'Reasoning effort',
        category: 'effort',
        description: 'How much Codex reasons before it answers.',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'low', description: 'Fast responses with lighter reasoning' },
          { value: 'high', name: 'high', description: 'Greater reasoning depth for complex problems' },
        ],
      },
      {
        type: 'select',
        id: 'service_tier',
        name: 'Speed',
        category: 'service_tier',
        description: 'Faster service tiers use more of your plan.',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Standard' },
          { value: 'priority', name: 'Fast', description: '2x speed, increased usage' },
        ],
      },
    ])
    // Text-only is a real "no"; no tiers means no speed setting and no Fast.
    expect(luna!.supportsImageInput).toBe(false)
    expect(luna!.supportsFastMode).toBe(false)
    expect(luna!.configOptions?.map((option) => option.id)).toEqual(['effort'])
  })

  // Review: Standard vanished when the catalog defaulted to another tier.
  it('keeps Standard pickable when the catalog defaults to another tier', () => {
    const [model] = codexModelListing([
      buildModel('m', { defaultServiceTier: 'priority' }),
    ]).availableModels!
    const speed = model!.configOptions?.find((option) => option.id === 'service_tier')
    expect(speed).toMatchObject({
      currentValue: 'priority',
      options: [{ value: 'default', name: 'Standard' }, { value: 'priority' }],
    })
  })

  it('carries unknown efforts and tiers through as Codex names them', () => {
    const [model] = codexModelListing([
      buildModel('m', {
        supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Delegates on its own' }],
        defaultReasoningEffort: 'ultra',
        serviceTiers: [{ id: 'flex', name: 'Flex', description: 'Cheaper, slower' }],
      }),
    ]).availableModels!
    expect(model!.effortLevels).toEqual(['ultra'])
    expect(model!.supportsFastMode).toBe(false)
    expect(model!.configOptions?.[1]).toMatchObject({
      options: [{ value: 'default' }, { value: 'flex', name: 'Flex' }],
    })
  })

  it('drops Fast when its feature is off or a policy pins it off', () => {
    for (const context of [
      { features: { fast_mode: false } },
      { requirements: buildRequirements({ featureRequirements: { fast_mode: false } }) },
    ]) {
      const [model] = codexModelListing([buildModel('m')], context).availableModels!
      // Said outright, so it replaces an earlier `true` downstream.
      expect(model!.supportsFastMode).toBe(false)
      expect(model!.configOptions?.map((option) => option.id)).toEqual(['effort'])
    }
  })

  it('takes a managed policy’s new-thread defaults where the catalog offers them', () => {
    const listing = codexModelListing(
      [buildModel('a', { isDefault: true }), buildModel('b')],
      {
        requirements: buildRequirements({
          models: { newThread: { model: 'b', modelReasoningEffort: 'high', serviceTier: 'priority' } },
        }),
      },
    )
    expect(listing.currentModelId).toBe('b')
    const b = listing.availableModels![1]!
    expect(b.configOptions?.map((option) => option.currentValue)).toEqual(['high', 'priority'])
  })

  // Review: the managed default names a model by its slug as often as its id.
  it('finds a managed default model by its slug too', () => {
    const listing = codexModelListing(
      [buildModel('a', { isDefault: true }), buildModel('b-preview', { model: 'b' })],
      { requirements: buildRequirements({ models: { newThread: { model: 'b', modelReasoningEffort: null, serviceTier: null } } }) },
    )
    expect(listing.currentModelId).toBe('b-preview')
  })

  it('carries upgrade and retirement', () => {
    expect(codexModelUpgrade(buildModel('m'))).toBeUndefined()
    expect(codexModelUpgrade(buildModel('m', { upgrade: 'n' }))).toEqual({ modelId: 'n' })
    const [model] = codexModelListing([
      buildModel('old', {
        upgrade: 'new',
        upgradeInfo: {
          model: 'new',
          upgradeCopy: 'Try the new one.',
          modelLink: 'https://example.com/new',
          migrationMarkdown: null,
          retirementAt: 1_798_761_600,
        },
      }),
    ]).availableModels!
    expect(model!.upgrade).toEqual({
      modelId: 'new',
      message: 'Try the new one.',
      link: 'https://example.com/new',
      retiresAt: '2027-01-01T00:00:00.000Z',
    })
  })
})

describe('codexPolicy', () => {
  it('rules nothing out without a policy', () => {
    expect(codexPolicy({ requirements: null })).toEqual({})
    expect(
      codexPolicy({
        requirements: buildRequirements(),
        permissionProfiles: buildPermissionProfiles(),
        features: { fast_mode: true, guardian_approval: true },
      }),
    ).toEqual({})
  })

  it('blocks the access presets a managed policy does not allow, with why', () => {
    const policy = codexPolicy({
      requirements: buildRequirements({
        allowedSandboxModes: ['read-only', 'workspace-write'],
        allowedApprovalsReviewers: ['user'],
      }),
    })
    expect(policy.blockedModes?.map((block) => block.id)).toEqual(['auto', 'full-access'])
    expect(policy.blockedModes?.[0]?.reason).toMatch(/administrator/)
  })

  it('blocks on approval policies and on the permission profiles Codex disallows', () => {
    expect(
      codexPolicy({
        requirements: buildRequirements({ allowedApprovalPolicies: ['on-request', 'never'] }),
      }).blockedModes?.map((block) => block.id),
    ).toEqual(['supervised'])
    expect(
      codexPolicy({
        permissionProfiles: buildPermissionProfiles({ ':danger-full-access': false }),
      }).blockedModes?.map((block) => block.id),
    ).toEqual(['full-access'])
  })

  it('blocks Auto when auto review is switched off, saying where', () => {
    const policy = codexPolicy({ features: { guardian_approval: false } })
    expect(policy.blockedModes).toEqual([
      { id: 'auto', reason: expect.stringMatching(/guardian_approval/) },
    ])
  })

  it('blocks Fast that a policy rules out, and names no setting no catalog offers', () => {
    const policy = codexPolicy({
      requirements: buildRequirements({
        allowedWebSearchModes: ['disabled', 'cached'],
        featureRequirements: { fast_mode: false },
      }),
    })
    expect(policy.blockedConfigValues).toEqual([
      { configId: 'service_tier', id: 'priority', reason: expect.stringMatching(/administrator/) },
    ])
  })

  // Review: a user's own `fast_mode = false` must be said too, not only dropped.
  it('blocks Fast that the user turned off in their config, saying where', () => {
    expect(codexPolicy({ features: { fast_mode: false } }).blockedConfigValues).toEqual([
      { configId: 'service_tier', id: 'priority', reason: expect.stringMatching(/fast_mode/) },
    ])
  })

  // Review: `guardian_subagent` is the older name of `auto_review`.
  it('lets a policy that allows the older reviewer name keep Auto', () => {
    const policy = codexPolicy({
      requirements: buildRequirements({ allowedApprovalsReviewers: ['user', 'guardian_subagent'] }),
    })
    expect(policy.blockedModes).toBeUndefined()
  })
})
