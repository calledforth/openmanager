import { describe, expect, it } from 'vitest'
import {
  codexEffortLabel,
  codexModelConfigOptions,
  codexModelListing,
  codexModelUpgrade,
  codexPolicy,
} from './codex-catalog.js'
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
      supportsAutoMode: true,
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
          { value: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' },
          { value: 'high', name: 'High', description: 'Greater reasoning depth for complex problems' },
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
      {
        type: 'select',
        id: 'web_search',
        name: 'Web search',
        category: 'web_search',
        description: 'Whether and how Codex searches the web. Kept per chat.',
        currentValue: 'cached',
        options: [
          { value: 'disabled', name: 'Off', description: 'Codex does not search the web.' },
          { value: 'cached', name: 'Cached', description: 'Searches a cached copy of the web.' },
          { value: 'indexed', name: 'Indexed', description: 'Searches an index of the web.' },
          { value: 'live', name: 'Live', description: 'Searches the live web.' },
        ],
      },
    ])
    // Text-only is a real "no"; no tiers means no speed setting and no Fast.
    expect(luna!.supportsImageInput).toBe(false)
    expect(luna!.supportsFastMode).toBe(false)
    expect(luna!.configOptions?.map((option) => option.id)).toEqual(['effort', 'web_search'])
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

  it('carries unknown efforts and tiers through as Codex names them, labelled apart from their ids', () => {
    const [model] = codexModelListing([
      buildModel('m', {
        supportedReasoningEfforts: [
          { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
          { reasoningEffort: 'hyper_focus', description: '' },
        ],
        defaultReasoningEffort: 'ultra',
        serviceTiers: [{ id: 'flex', name: '', description: 'Cheaper, slower' }],
      }),
    ]).availableModels!
    expect(model!.effortLevels).toEqual(['xhigh', 'ultra', 'hyper_focus'])
    expect(model!.supportsFastMode).toBe(false)
    expect(model!.configOptions?.[0]).toMatchObject({
      currentValue: 'ultra',
      options: [
        { value: 'xhigh', name: 'Extra high' },
        {
          value: 'ultra',
          name: 'Ultra',
          description: 'Maximum reasoning with automatic task delegation. May start subagents on its own.',
        },
        // A level this version has never heard of: kept, with a readable label.
        { value: 'hyper_focus', name: 'Hyper focus' },
      ],
    })
    expect(model!.configOptions?.[1]).toMatchObject({
      options: [{ value: 'default' }, { value: 'flex', name: 'Flex' }],
    })
  })

  it('labels the efforts Codex knows today', () => {
    expect(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(codexEffortLabel)).toEqual([
      'None',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
      'Ultra',
    ])
  })

  it('shows a thread’s read-back settings over the defaults, standard speed included', () => {
    const options = codexModelConfigOptions(
      buildModel('m'),
      { webSearch: 'live' },
      { effort: 'high', serviceTier: 'default', webSearch: null },
    )
    expect(options.map((option) => option.currentValue)).toEqual(['high', 'default', 'live'])
    const chosen = codexModelConfigOptions(buildModel('m'), { webSearch: 'live' }, { webSearch: 'disabled' })
    expect(chosen.map((option) => option.currentValue)).toEqual(['low', 'default', 'disabled'])
  })

  it('offers only the web search modes a policy allows', () => {
    const [model] = codexModelListing([buildModel('m')], {
      requirements: buildRequirements({ allowedWebSearchModes: ['disabled', 'live'] }),
      webSearch: 'cached',
    }).availableModels!
    expect(model!.configOptions?.find((option) => option.id === 'web_search')).toMatchObject({
      // The user's `cached` is not allowed: the first mode that is shows.
      currentValue: 'disabled',
      options: [{ value: 'disabled' }, { value: 'live' }],
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
      expect(model!.configOptions?.map((option) => option.id)).toEqual(['effort', 'web_search'])
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
    expect(b.configOptions?.map((option) => option.currentValue)).toEqual(['high', 'priority', 'cached'])
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

  it('blocks Fast and the web search modes a policy rules out', () => {
    const policy = codexPolicy({
      requirements: buildRequirements({
        allowedWebSearchModes: ['disabled', 'cached'],
        featureRequirements: { fast_mode: false },
      }),
    })
    expect(policy.blockedConfigValues).toEqual([
      { configId: 'service_tier', id: 'priority', reason: expect.stringMatching(/administrator/) },
      { configId: 'web_search', id: 'indexed', reason: expect.stringMatching(/administrator/) },
      { configId: 'web_search', id: 'live', reason: expect.stringMatching(/administrator/) },
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
