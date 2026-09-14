# iFinder field reference

Generated from the iFinder 6 index schema. Columns:

- **Exact / facet / sort** — the suffix a field needs to be filtered on
  exactly, used as a facet id, or sorted by. `` `.keyword` `` means append it;
  `— (typed)` means the field is already exact (date, number, boolean,
  hierarchy) and takes no suffix; `—` means the field supports none of these —
  a filter or facet on it matches nothing rather than erroring.
- **Full-text** — whether the plain field name matches words. `yes (default)`
  means a bare query reaches it without naming it; `yes (named)` means you must
  write `field:term`; `no` means the plain name matches nothing and only the
  `.keyword` variant works.

`iFinder_getFields` reports the same per-purpose names live from the
deployment, including custom `cust.*` fields this table cannot list. Prefer it
whenever the two disagree.

### Agent fields

Written by the indexer that pulled the document in.

| Field                                        | Type    | Exact / facet / sort | Full-text     |
| -------------------------------------------- | ------- | -------------------- | ------------- |
| `accessInfo.deepLink`                        | text    | `.keyword`           | no            |
| `accessInfo.download.itemType`               | text    | `.keyword`           | no            |
| `accessInfo.download.itemId`                 | text    | `.keyword`           | no            |
| `accessInfo.download.subItemExtractionPath`  | text    | `.keyword`           | no            |
| `accessInfo.lastModifiedDate`                | date    | — (typed)            | yes (named)   |
| `accessInfo.source`                          | text    | `.keyword`           | no            |
| `accessInfo.thumbnail.itemType`              | text    | `.keyword`           | no            |
| `accessInfo.thumbnail.itemId`                | text    | `.keyword`           | no            |
| `accessInfo.thumbnail.subItemExtractionPath` | text    | `.keyword`           | no            |
| `accessInfo.preview.itemType`                | text    | `.keyword`           | no            |
| `accessInfo.preview.itemId`                  | text    | `.keyword`           | no            |
| `accessInfo.preview.subItemExtractionPath`   | text    | `.keyword`           | no            |
| `accessInfo.thumbnailContent`                | binary  | —                    | yes (named)   |
| `aclAllows`                                  | text    | `.keyword`           | no            |
| `aclDenies`                                  | text    | `.keyword`           | no            |
| `aclDeniesFolder`                            | text    | `.keyword`           | no            |
| `aclInheritanceBreak`                        | text    | `.keyword`           | yes (named)   |
| `agentTags`                                  | text    | `.keyword`           | no            |
| `agentType`                                  | text    | `.keyword`           | no            |
| `agentVersion`                               | text    | `.keyword`           | no            |
| `comments.content`                           | text    | —                    | yes (default) |
| `content`                                    | text    | —                    | yes (default) |
| `context`                                    | text    | `.keyword`           | no            |
| `creationDate`                               | date    | — (typed)            | yes (named)   |
| `creators`                                   | text    | `.keyword`           | yes (default) |
| `documentClasses`                            | text    | `.keyword`           | yes (default) |
| `documentType`                               | text    | `.keyword`           | yes (named)   |
| `isTruncated`                                | boolean | — (typed)            | yes (named)   |
| `mediaType`                                  | text    | `.keyword`           | yes (default) |
| `modificationDate`                           | date    | — (typed)            | yes (named)   |
| `navigationTreeDepth`                        | integer | — (typed)            | yes (named)   |
| `ocr.exception`                              | text    | —                    | no            |
| `ocr.status`                                 | text    | `.keyword`           | no            |
| `owners`                                     | text    | `.keyword`           | yes (default) |
| `parent.label`                               | text    | —                    | yes (named)   |
| `parent.type`                                | text    | `.keyword`           | no            |
| `parent.url`                                 | text    | —                    | yes (named)   |
| `schemaVersion`                              | text    | `.keyword`           | no            |
| `sourceLabels`                               | text    | `.keyword`           | yes (default) |
| `sourceLocations.label`                      | text    | `.keyword`           | yes (default) |
| `sourceLocations.url`                        | text    | `.keyword`           | yes (default) |
| `sourceType`                                 | text    | `.keyword`           | yes (default) |
| `subject`                                    | text    | —                    | yes (default) |
| `tenant`                                     | text    | `.keyword`           | yes (named)   |
| `title`                                      | text    | —                    | yes (default) |
| `url`                                        | text    | —                    | yes (default) |

### Application fields

Added by iFinder itself; indexers must not write them.

| Field                      | Type         | Exact / facet / sort | Full-text     |
| -------------------------- | ------------ | -------------------- | ------------- |
| `application`              | text         | `.keyword`           | yes (default) |
| `boostTerms`               | text         | —                    | yes (named)   |
| `contentHash`              | text         | `.keyword`           | no            |
| `contentLength`            | long         | — (typed)            | yes (named)   |
| `enrichment.addresses`     | text         | `.keyword`           | yes (named)   |
| `enrichment.dateOfBirth`   | text         | `.keyword`           | yes (named)   |
| `enrichment.emails`        | text         | `.keyword`           | yes (named)   |
| `enrichment.entityCount`   | integer      | — (typed)            | yes (named)   |
| `enrichment.entityTypes`   | text         | `.keyword`           | yes (named)   |
| `enrichment.hasEntities`   | boolean      | — (typed)            | yes (named)   |
| `enrichment.personNames`   | text         | `.keyword`           | yes (named)   |
| `id`                       | text         | `.keyword`           | no            |
| `idHash`                   | text         | `.keyword`           | no            |
| `indexingDate`             | date         | — (typed)            | yes (named)   |
| `labels`                   | text         | `.keyword`           | yes (default) |
| `language`                 | text         | `.keyword`           | yes (named)   |
| `languages`                | text         | `.keyword`           | yes (named)   |
| `navigationTree`           | tree_keyword | — (typed)            | yes (named)   |
| `otherText`                | text         | —                    | yes (default) |
| `significantTerms`         | text         | `.keyword`           | yes (default) |
| `sourceName`               | text         | `.keyword`           | yes (named)   |
| `ubi.interactions.count`   | integer      | — (typed)            | yes (named)   |
| `ubi.interactions.queries` | text         | —                    | yes (named)   |

### Document-class fields

A document declares its classes in `documentClasses`; these fields only appear on documents of that class.

#### Announcement

| Field                    | Type       | Exact / facet / sort | Full-text   |
| ------------------------ | ---------- | -------------------- | ----------- |
| `announcement.dateRange` | date_range | — (typed)            | yes (named) |

#### Appointment

| Field                             | Type       | Exact / facet / sort | Full-text     |
| --------------------------------- | ---------- | -------------------- | ------------- |
| `appointment.attendees`           | text       | `.keyword`           | yes (default) |
| `appointment.dateRange`           | date_range | — (typed)            | yes (named)   |
| `appointment.duration`            | long       | — (typed)            | yes (named)   |
| `appointment.location`            | text       | `.keyword`           | yes (default) |
| `appointment.locationCoordinates` | geo_point  | — (typed)            | yes (named)   |
| `appointment.meetingUrl`          | text       | —                    | yes (named)   |
| `appointment.organizer`           | text       | `.keyword`           | yes (default) |
| `appointment.startDate`           | date       | — (typed)            | yes (named)   |

#### Attachment

| Field                         | Type | Exact / facet / sort | Full-text   |
| ----------------------------- | ---- | -------------------- | ----------- |
| `attachment.parent.id`        | text | `.keyword`           | no          |
| `attachment.parent.mediaType` | text | `.keyword`           | no          |
| `attachment.parent.title`     | text | —                    | yes (named) |

#### Container

| Field                         | Type    | Exact / facet / sort | Full-text   |
| ----------------------------- | ------- | -------------------- | ----------- |
| `container.entries.id`        | text    | `.keyword`           | no          |
| `container.entries.mediaType` | text    | `.keyword`           | no          |
| `container.entries.title`     | text    | —                    | yes (named) |
| `container.entriesCount`      | integer | — (typed)            | yes (named) |

#### Document

| Field                | Type    | Exact / facet / sort | Full-text   |
| -------------------- | ------- | -------------------- | ----------- |
| `document.pageCount` | integer | — (typed)            | yes (named) |

#### File

| Field              | Type    | Exact / facet / sort | Full-text     |
| ------------------ | ------- | -------------------- | ------------- |
| `file.extension`   | text    | `.keyword`           | yes (named)   |
| `file.isDirectory` | boolean | — (typed)            | yes (named)   |
| `file.isLink`      | boolean | — (typed)            | yes (named)   |
| `file.linkTarget`  | text    | `.keyword`           | no            |
| `file.name`        | text    | `.keyword`           | yes (default) |
| `file.size`        | long    | — (typed)            | yes (named)   |

#### Image

| Field          | Type    | Exact / facet / sort | Full-text   |
| -------------- | ------- | -------------------- | ----------- |
| `image.height` | integer | — (typed)            | yes (named) |
| `image.type`   | text    | `.keyword`           | yes (named) |
| `image.width`  | integer | — (typed)            | yes (named) |

#### Message

| Field                | Type | Exact / facet / sort | Full-text   |
| -------------------- | ---- | -------------------- | ----------- |
| `message.recipients` | text | `.keyword`           | yes (named) |
| `message.sendDate`   | date | — (typed)            | yes (named) |
| `message.sender`     | text | `.keyword`           | yes (named) |

#### Person

| Field                        | Type | Exact / facet / sort | Full-text   |
| ---------------------------- | ---- | -------------------- | ----------- |
| `person.addresses`           | text | —                    | yes (named) |
| `person.assistant`           | text | `.keyword`           | yes (named) |
| `person.business.city`       | text | `.keyword`           | yes (named) |
| `person.business.country`    | text | `.keyword`           | yes (named) |
| `person.business.email`      | text | `.keyword`           | yes (named) |
| `person.business.phone`      | text | `.keyword`           | yes (named) |
| `person.business.postalcode` | text | `.keyword`           | yes (named) |
| `person.business.state`      | text | `.keyword`           | yes (named) |
| `person.business.street`     | text | `.keyword`           | yes (named) |
| `person.company`             | text | `.keyword`           | yes (named) |
| `person.emails`              | text | `.keyword`           | yes (named) |
| `person.firstname`           | text | `.keyword`           | yes (named) |
| `person.fullname`            | text | `.keyword`           | yes (named) |
| `person.honorific`           | text | `.keyword`           | yes (named) |
| `person.middlename`          | text | `.keyword`           | yes (named) |
| `person.lastname`            | text | `.keyword`           | yes (named) |
| `person.private.city`        | text | `.keyword`           | yes (named) |
| `person.private.country`     | text | `.keyword`           | yes (named) |
| `person.private.email`       | text | `.keyword`           | yes (named) |
| `person.private.phone`       | text | `.keyword`           | yes (named) |
| `person.private.postalcode`  | text | `.keyword`           | yes (named) |
| `person.private.state`       | text | `.keyword`           | yes (named) |
| `person.private.street`      | text | `.keyword`           | yes (named) |

#### Project

| Field          | Type | Exact / facet / sort | Full-text     |
| -------------- | ---- | -------------------- | ------------- |
| `project.id`   | text | `.keyword`           | no            |
| `project.name` | text | `.keyword`           | yes (default) |

#### Task

| Field              | Type | Exact / facet / sort | Full-text     |
| ------------------ | ---- | -------------------- | ------------- |
| `task.assignee`    | text | `.keyword`           | yes (default) |
| `task.dueDate`     | date | — (typed)            | yes (named)   |
| `task.id`          | text | `.keyword`           | no            |
| `task.priority`    | text | `.keyword`           | yes (named)   |
| `task.projectKey`  | text | `.keyword`           | yes (named)   |
| `task.projectName` | text | `.keyword`           | yes (named)   |
| `task.status`      | text | `.keyword`           | yes (named)   |
| `task.type`        | text | `.keyword`           | yes (named)   |

### Processing fields

Pipeline status written by the converter, OCR and enrichment services. Useful for diagnosing why a document has no content.

| Field                                            | Type | Exact / facet / sort | Full-text   |
| ------------------------------------------------ | ---- | -------------------- | ----------- |
| `processing.callback.url`                        | text | `.keyword`           | no          |
| `processing.contentExtraction.error`             | text | —                    | yes (named) |
| `processing.contentExtraction.lastProcessedDate` | date | — (typed)            | yes (named) |
| `processing.contentExtraction.spanId`            | text | `.keyword`           | no          |
| `processing.contentExtraction.status`            | text | `.keyword`           | no          |
| `processing.contentExtraction.traceId`           | text | `.keyword`           | no          |
| `processing.contentExtraction.type`              | text | `.keyword`           | no          |
| `processing.contentExtraction.version`           | text | `.keyword`           | no          |
| `processing.enricher.type`                       | text | `.keyword`           | no          |
| `processing.enricher.version`                    | text | `.keyword`           | no          |
| `processing.ocr.error`                           | text | —                    | yes (named) |
| `processing.ocr.lastProcessedDate`               | date | — (typed)            | yes (named) |
| `processing.ocr.spanId`                          | text | `.keyword`           | no          |
| `processing.ocr.status`                          | text | `.keyword`           | no          |
| `processing.ocr.traceId`                         | text | `.keyword`           | no          |
| `processing.ocr.type`                            | text | `.keyword`           | no          |
| `processing.ocr.version`                         | text | `.keyword`           | no          |

### Custom fields

Deployment-specific fields carry a `cust.` prefix and are not listed here —
`iFinder_getFields({ filterPrefix: "cust." })` enumerates them live. Unless a
naming convention applies, a custom field is full-text searchable under its
plain name and exact-matchable under `<name>.keyword`.

Field-name suffixes select an index template, which is what decides the type:

| Suffix pattern                                                            | Type                        | `.keyword` | Example                   |
| ------------------------------------------------------------------------- | --------------------------- | ---------- | ------------------------- |
| `*_date`, `*_dates`                                                       | date                        | —          | `cust.release_date`       |
| `*_dateRange(s)`                                                          | date_range                  | —          | `cust.validity_dateRange` |
| `*_integer(s)`, `*_count(s)`, `*_size(s)`, `*_length(s)`, `*_duration(s)` | long                        | —          | `cust.upvote_count`       |
| `*_double(s)`, `*_decimal(s)`                                             | double                      | —          | `cust.score_double`       |
| `*_boolean(s)`                                                            | boolean                     | —          | `cust.approved_boolean`   |
| `*_name(s)`, `*_label(s)`, `*_type(s)`, `*_class(es)`, `*_mediaType(s)`   | text                        | yes        | `cust.owner_names`        |
| `*_text(s)`, `*_url(s)`, `*_email(s)`                                     | text                        | no         | `cust.remarks_texts`      |
| `*_hierarchy`, `*_hierarchies`                                            | tree_keyword                | —          | `cust.org_hierarchy`      |
| `*_hash(es)`                                                              | text, not searchable        | yes        | `cust.checksum_hash`      |
| `*_version(s)`                                                            | text                        | yes        | `cust.doc_version`        |
| `*_coordinates`                                                           | geo_point                   | —          | `cust.site_coordinates`   |
| `*_stored`                                                                | stored only, not searchable | —          | `cust.raw_stored`         |

A field may also carry a language tag: `title#en`, `cust.remarks_texts#de`.

### Field naming

```
[<documentClass>.]<fieldName>[_<fieldType>][#<languageTag>]
```

Standard names are lower-camel (`file.name`, `modificationDate`); custom ones
start with an uppercase letter or the `cust.` prefix.
