alter table public.vehicles
  add column if not exists brand text,
  add column if not exists model text,
  add column if not exists color text;

create or replace view public.visit_details as
 SELECT l.id,
    l.plate_number,
    l.plate_norm,
    l.province,
    l.vehicle_type,
    l.image_path,
    l.ocr_confidence,
    l.ocr_provider,
    l.capture_at,
    l.capture_date,
    l.day,
    l.month,
    l.year,
    l.note,
    l.created_by,
    l.created_at,
    l.vehicle_id,
    l.status,
    l.source,
    v.company_id,
    c.company_name,
    c.logo_url,
    c.brand_color,
    v.brand AS vehicle_brand,
    v.model AS vehicle_model,
    v.color AS vehicle_color
   FROM vehicle_logs l
     LEFT JOIN vehicles v ON v.id = l.vehicle_id
     LEFT JOIN companies c ON c.id = v.company_id;
